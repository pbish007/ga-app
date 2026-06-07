import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestSuite, type TestDb } from "@ga/db";
import { AircraftService } from "@ga/aircraft";

import {
  handleAircraftFaaDecisionsList,
  handleAircraftFaaDecisionsRecord,
} from "../lib/aircraft-faa-decisions-handler";

interface Seed {
  tenantId: string;
  userId: string;
  aircraftId: string;
}

async function seed(db: TestDb): Promise<Seed> {
  const regime = await db.execute<{ id: string }>(
    sql`select id from regimes where code = 'FAA'`,
  );
  const regimeId = regime.rows[0]!.id;
  const orgs = await db.execute<{ id: string }>(sql`
    insert into organizations (name, org_type, default_regime_id)
    values ('Test Tenant', 'club', ${regimeId})
    returning id
  `);
  const users = await db.execute<{ id: string }>(sql`
    insert into users (email, password_hash)
    values ('decider@example.test', 'x')
    returning id
  `);
  const svc = new AircraftService(db);
  const ac = await svc.create({
    tenantId: orgs.rows[0]!.id,
    registration: "N12345",
    make: "Cessna",
    model: "172N",
    serialNumber: "17270001",
    category: "normal",
    aircraftClass: "single_engine_land",
    timeSource: "hobbs",
  });
  return {
    tenantId: orgs.rows[0]!.id,
    userId: users.rows[0]!.id,
    aircraftId: ac.id,
  };
}

function jsonRequest(body: unknown): Request {
  return new Request("https://example.test/decision", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("aircraft-faa-decisions-handler", () => {
  let db: TestDb;
  let reset: () => Promise<void>;
  let s: Seed;
  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });
  beforeEach(async () => {
    s = await seed(db);
  });
  afterEach(async () => {
    await reset();
  });

  it("rejects a non-UUID aircraft id with 400", async () => {
    const res = await handleAircraftFaaDecisionsList(new Request("https://x"), {
      tenantId: s.tenantId,
      decidedByUserId: s.userId,
      db,
      params: { id: "not-a-uuid" },
    });
    expect(res.status).toBe(400);
  });

  it("returns an empty list before any decisions", async () => {
    const res = await handleAircraftFaaDecisionsList(new Request("https://x"), {
      tenantId: s.tenantId,
      decidedByUserId: s.userId,
      db,
      params: { id: s.aircraftId },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decisions).toEqual([]);
  });

  it("records a tenant_wins decision and lists it back", async () => {
    const recordRes = await handleAircraftFaaDecisionsRecord(
      jsonRequest({
        field_key: "model",
        decision: "tenant_wins",
        faa_value: "Cessna 172S",
        tenant_value: "172N",
      }),
      {
        tenantId: s.tenantId,
        decidedByUserId: s.userId,
        db,
        params: { id: s.aircraftId },
      },
    );
    expect(recordRes.status).toBe(200);
    const recorded = (await recordRes.json()).decision;
    expect(recorded.field_key).toBe("model");
    expect(recorded.decision).toBe("tenant_wins");
    expect(recorded.faa_value).toBe("Cessna 172S");
    expect(recorded.tenant_value).toBe("172N");
    expect(recorded.n_number).toBe("12345");
    expect(recorded.faa_value_hash).toMatch(/^[0-9a-f]{64}$/);

    const listRes = await handleAircraftFaaDecisionsList(new Request("https://x"), {
      tenantId: s.tenantId,
      decidedByUserId: s.userId,
      db,
      params: { id: s.aircraftId },
    });
    const list = await listRes.json();
    expect(list.decisions).toHaveLength(1);
    expect(list.decisions[0].field_key).toBe("model");
  });

  it("rejects an unknown field_key with 400", async () => {
    const res = await handleAircraftFaaDecisionsRecord(
      jsonRequest({
        field_key: "not_a_field",
        decision: "tenant_wins",
        faa_value: "x",
        tenant_value: "y",
      }),
      {
        tenantId: s.tenantId,
        decidedByUserId: s.userId,
        db,
        params: { id: s.aircraftId },
      },
    );
    expect(res.status).toBe(400);
  });

  it("rejects a faa_reported_wrong without report_reason with 400", async () => {
    const res = await handleAircraftFaaDecisionsRecord(
      jsonRequest({
        field_key: "owner_name",
        decision: "faa_reported_wrong",
        faa_value: "WRONG OWNER",
        tenant_value: "Right Owner LLC",
      }),
      {
        tenantId: s.tenantId,
        decidedByUserId: s.userId,
        db,
        params: { id: s.aircraftId },
      },
    );
    expect(res.status).toBe(400);
  });

  it("accepts a faa_reported_wrong with reason + note", async () => {
    const res = await handleAircraftFaaDecisionsRecord(
      jsonRequest({
        field_key: "owner_name",
        decision: "faa_reported_wrong",
        faa_value: "WRONG OWNER",
        tenant_value: "Right Owner LLC",
        report_reason: "stale_data",
        report_note: "Sold March 2026; FAA registry not yet updated.",
      }),
      {
        tenantId: s.tenantId,
        decidedByUserId: s.userId,
        db,
        params: { id: s.aircraftId },
      },
    );
    expect(res.status).toBe(200);
    const recorded = (await res.json()).decision;
    expect(recorded.report_reason).toBe("stale_data");
    expect(recorded.report_note).toContain("Sold March");
  });

  it("upserts in place when a second decision lands on the same field", async () => {
    await handleAircraftFaaDecisionsRecord(
      jsonRequest({
        field_key: "model",
        decision: "tenant_wins",
        faa_value: "Cessna 172S",
        tenant_value: "172N",
      }),
      {
        tenantId: s.tenantId,
        decidedByUserId: s.userId,
        db,
        params: { id: s.aircraftId },
      },
    );
    const second = await handleAircraftFaaDecisionsRecord(
      jsonRequest({
        field_key: "model",
        decision: "accepted_faa",
        faa_value: "Cessna 172S",
        tenant_value: "Cessna 172S",
      }),
      {
        tenantId: s.tenantId,
        decidedByUserId: s.userId,
        db,
        params: { id: s.aircraftId },
      },
    );
    expect((await second.json()).decision.decision).toBe("accepted_faa");

    const list = await (
      await handleAircraftFaaDecisionsList(new Request("https://x"), {
        tenantId: s.tenantId,
        decidedByUserId: s.userId,
        db,
        params: { id: s.aircraftId },
      })
    ).json();
    expect(list.decisions).toHaveLength(1);
  });
});
