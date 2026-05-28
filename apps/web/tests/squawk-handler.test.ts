import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestSuite, type TestDb } from "@ga/db";
import { AircraftService, SquawkService } from "@ga/aircraft";

import {
  handleSquawkCreate,
  handleSquawkList,
  handleSquawkResolve,
} from "../lib/squawk-handler";
import { handleComplianceDueList } from "../lib/compliance-handler";

async function seedTenant(db: TestDb, name = "Org"): Promise<string> {
  const regime = await db.execute<{ id: string }>(
    sql`select id from regimes where code = 'FAA'`,
  );
  const regimeId = regime.rows[0]!.id;
  const orgs = await db.execute<{ id: string }>(sql`
    insert into organizations (name, org_type, default_regime_id)
    values (${name}, 'club', ${regimeId})
    returning id
  `);
  return orgs.rows[0]!.id;
}

async function seedUser(db: TestDb, email: string): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into users (email) values (${email}) returning id
  `);
  return rows.rows[0]!.id;
}

async function seedAircraft(db: TestDb, tenantId: string, reg: string) {
  const svc = new AircraftService(db);
  return svc.create({
    tenantId,
    registration: reg,
    make: "Cessna",
    model: "172N",
    serialNumber: `SN-${reg}`,
    category: "normal",
    aircraftClass: "single_engine_land",
    timeSource: "hobbs",
  });
}

function jsonRequest(body: unknown, method = "POST"): Request {
  return new Request("https://example.test/api/squawks", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleSquawkCreate (E1.2)", () => {
  let db: TestDb;
  let tenantId: string;
  let userId: string;
  let aircraftId: string;
  let reset: () => Promise<void>;

  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });

  beforeEach(async () => {
    tenantId = await seedTenant(db);
    userId = await seedUser(db, "pilot@test");
    const ac = await seedAircraft(db, tenantId, "N12345");
    aircraftId = ac.id;
  });

  afterEach(async () => {
    await reset();
  });

  it("creates a squawk with severity=grounding and reporter from session", async () => {
    const res = await handleSquawkCreate(
      jsonRequest({
        description: "Pitot blocked",
        severity: "grounding",
        occurred_at: "2026-05-20T15:00:00Z",
      }),
      { tenantId, userId, db, params: { id: aircraftId } },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.description).toBe("Pitot blocked");
    expect(body.severity).toBe("grounding");
    expect(body.status).toBe("open");
    expect(body.reporter_user_id).toBe(userId);
    expect(body.aircraft_id).toBe(aircraftId);
  });

  it("rejects missing description with 400", async () => {
    const res = await handleSquawkCreate(
      jsonRequest({ severity: "informational" }),
      { tenantId, userId, db, params: { id: aircraftId } },
    );
    expect(res.status).toBe(400);
  });

  it("rejects invalid severity with 400", async () => {
    const res = await handleSquawkCreate(
      jsonRequest({ description: "x", severity: "critical" }),
      { tenantId, userId, db, params: { id: aircraftId } },
    );
    expect(res.status).toBe(400);
  });

  it("rejects non-UUID aircraft id with 400", async () => {
    const res = await handleSquawkCreate(
      jsonRequest({ description: "x", severity: "deferred" }),
      { tenantId, userId, db, params: { id: "not-a-uuid" } },
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown aircraft", async () => {
    const res = await handleSquawkCreate(
      jsonRequest({ description: "x", severity: "deferred" }),
      {
        tenantId,
        userId,
        db,
        params: { id: "00000000-0000-0000-0000-000000000000" },
      },
    );
    expect(res.status).toBe(404);
  });

  it("rejects photo_document_ids that contain non-UUID values with 400", async () => {
    const res = await handleSquawkCreate(
      jsonRequest({
        description: "x",
        severity: "informational",
        photo_document_ids: ["not-a-uuid"],
      }),
      { tenantId, userId, db, params: { id: aircraftId } },
    );
    expect(res.status).toBe(400);
  });
});

describe("handleSquawkList + handleSquawkResolve", () => {
  let db: TestDb;
  let reset: () => Promise<void>;
  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });
  afterEach(async () => {
    await reset();
  });

  it("lists squawks then resolves one", async () => {
    const tenantId = await seedTenant(db);
    const userId = await seedUser(db, "mech@test");
    const ac = await seedAircraft(db, tenantId, "N99999");

    const svc = new SquawkService(db);
    const { squawk } = await svc.file({
      tenantId,
      aircraftId: ac.id,
      description: "Brake spongy",
      severity: "deferred",
    });

    const listRes = await handleSquawkList(
      new Request("https://example.test/x"),
      { tenantId, db, params: { id: ac.id } },
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      squawks: Array<{ id: string; status: string }>;
    };
    expect(listBody.squawks).toHaveLength(1);
    expect(listBody.squawks[0]!.status).toBe("open");

    const resolveRes = await handleSquawkResolve(
      jsonRequest({ resolution_notes: "Bled brakes" }),
      { tenantId, userId, db, params: { squawkId: squawk.id } },
    );
    expect(resolveRes.status).toBe(200);
    const resolveBody = (await resolveRes.json()) as Record<string, unknown>;
    expect(resolveBody.status).toBe("resolved");
    expect(resolveBody.resolved_by_user_id).toBe(userId);
    expect(resolveBody.resolution_notes).toBe("Bled brakes");

    // Second resolve is rejected as already_resolved.
    const dupRes = await handleSquawkResolve(
      jsonRequest({}),
      { tenantId, userId, db, params: { squawkId: squawk.id } },
    );
    expect(dupRes.status).toBe(409);
  });
});

describe("E1.3 — compliance dashboard surfaces grounding squawks", () => {
  let db: TestDb;
  let reset: () => Promise<void>;
  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });
  afterEach(async () => {
    await reset();
  });

  it("flips airworthiness to overdue when a grounding squawk is open", async () => {
    const tenantId = await seedTenant(db);
    const ac = await seedAircraft(db, tenantId, "N11111");

    // Baseline: no squawks, no subs → ok.
    const baseline = await handleComplianceDueList(
      new Request("https://example.test/x"),
      { tenantId, db, params: { aircraftId: ac.id } },
    );
    expect(baseline.status).toBe(200);
    const baselineBody = (await baseline.json()) as {
      airworthiness_status: string;
      open_grounding_squawks: unknown[];
    };
    expect(baselineBody.airworthiness_status).toBe("ok");
    expect(baselineBody.open_grounding_squawks).toEqual([]);

    // File a grounding squawk → airworthiness becomes overdue.
    const svc = new SquawkService(db);
    const { squawk } = await svc.file({
      tenantId,
      aircraftId: ac.id,
      description: "Stuck flap motor",
      severity: "grounding",
    });

    const grounded = await handleComplianceDueList(
      new Request("https://example.test/x"),
      { tenantId, db, params: { aircraftId: ac.id } },
    );
    const groundedBody = (await grounded.json()) as {
      airworthiness_status: string;
      open_grounding_squawks: Array<{ id: string; description: string }>;
    };
    expect(groundedBody.airworthiness_status).toBe("overdue");
    expect(groundedBody.open_grounding_squawks).toHaveLength(1);
    expect(groundedBody.open_grounding_squawks[0]!.id).toBe(squawk.id);

    // Resolve the squawk → airworthiness flips back to ok.
    await svc.resolve({ tenantId, squawkId: squawk.id });
    const restored = await handleComplianceDueList(
      new Request("https://example.test/x"),
      { tenantId, db, params: { aircraftId: ac.id } },
    );
    const restoredBody = (await restored.json()) as {
      airworthiness_status: string;
      open_grounding_squawks: unknown[];
    };
    expect(restoredBody.airworthiness_status).toBe("ok");
    expect(restoredBody.open_grounding_squawks).toEqual([]);
  });

  it("a non-grounding open squawk does not affect airworthiness", async () => {
    const tenantId = await seedTenant(db);
    const ac = await seedAircraft(db, tenantId, "N22222");
    const svc = new SquawkService(db);
    await svc.file({
      tenantId,
      aircraftId: ac.id,
      description: "Cosmetic scratch on engine cowl",
      severity: "informational",
    });
    await svc.file({
      tenantId,
      aircraftId: ac.id,
      description: "Right brake spongy",
      severity: "deferred",
    });
    const res = await handleComplianceDueList(
      new Request("https://example.test/x"),
      { tenantId, db, params: { aircraftId: ac.id } },
    );
    const body = (await res.json()) as {
      airworthiness_status: string;
      open_grounding_squawks: unknown[];
    };
    expect(body.airworthiness_status).toBe("ok");
    expect(body.open_grounding_squawks).toEqual([]);
  });
});
