import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestSuite, type TestDb } from "@ga/db";

import {
  AircraftService,
  SquawkAircraftNotFoundError,
  SquawkAlreadyResolvedError,
  SquawkPhotoCrossTenantError,
  SquawkService,
  SquawkValidationError,
} from "../src/index.js";

async function seedTenant(db: TestDb, name: string): Promise<string> {
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

async function seedAircraft(
  db: TestDb,
  tenantId: string,
  reg: string,
) {
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

async function seedDocument(
  db: TestDb,
  tenantId: string,
  filename = "evidence.jpg",
): Promise<string> {
  const idRow = await db.execute<{ id: string }>(sql`
    insert into documents (
      tenant_id, document_type, object_key, storage_provider, storage_url,
      original_filename, content_type, byte_size, sha256_hex
    ) values (
      ${tenantId}, 'squawk_photo',
      'tenants/' || ${tenantId} || '/squawk_photo/' || gen_random_uuid()::text || '/' || ${filename},
      'memory', 'memory://' || gen_random_uuid()::text,
      ${filename}, 'image/jpeg', 1024, 'deadbeef'
    ) returning id
  `);
  return idRow.rows[0]!.id;
}

describe("SquawkService (E1)", () => {
  let db: TestDb;
  let reset: () => Promise<void>;
  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });
  afterEach(async () => {
    await reset();
  });

  it("files a squawk with severity and reporter", async () => {
    const tenantId = await seedTenant(db, "Org A");
    const userId = await seedUser(db, "pilot@a.test");
    const ac = await seedAircraft(db, tenantId, "N111A");
    const svc = new SquawkService(db);

    const { squawk } = await svc.file({
      tenantId,
      aircraftId: ac.id,
      description: "Left brake spongy",
      severity: "deferred",
      reporterUserId: userId,
      occurredAt: new Date("2026-05-20T15:00:00Z"),
    });
    expect(squawk.description).toBe("Left brake spongy");
    expect(squawk.severity).toBe("deferred");
    expect(squawk.status).toBe("open");
    expect(squawk.reporterUserId).toBe(userId);
    expect(squawk.resolvedAt).toBeNull();
  });

  it("rejects empty description and invalid severity at the app layer", async () => {
    const tenantId = await seedTenant(db, "Org B");
    const ac = await seedAircraft(db, tenantId, "N222B");
    const svc = new SquawkService(db);
    await expect(
      svc.file({
        tenantId,
        aircraftId: ac.id,
        description: "   ",
        severity: "informational",
      }),
    ).rejects.toThrow(SquawkValidationError);
    await expect(
      svc.file({
        tenantId,
        aircraftId: ac.id,
        description: "x",
        // @ts-expect-error: intentionally invalid
        severity: "bogus",
      }),
    ).rejects.toThrow(SquawkValidationError);
  });

  it("rejects filing against an aircraft from another tenant", async () => {
    const tenantA = await seedTenant(db, "Org A");
    const tenantB = await seedTenant(db, "Org B");
    const acB = await seedAircraft(db, tenantB, "N999X");
    const svc = new SquawkService(db);
    await expect(
      svc.file({
        tenantId: tenantA,
        aircraftId: acB.id,
        description: "Cross-tenant attempt",
        severity: "informational",
      }),
    ).rejects.toThrow(SquawkAircraftNotFoundError);
  });

  it("attaches photos from documents (J2.1) and persists join rows", async () => {
    const tenantId = await seedTenant(db, "Org C");
    const ac = await seedAircraft(db, tenantId, "N333C");
    const docA = await seedDocument(db, tenantId, "overview.jpg");
    const docB = await seedDocument(db, tenantId, "closeup.jpg");
    const svc = new SquawkService(db);

    const { squawk, photos } = await svc.file({
      tenantId,
      aircraftId: ac.id,
      description: "Cracked plexi over left seat",
      severity: "grounding",
      photoDocumentIds: [docA, docB],
    });
    expect(photos).toHaveLength(2);
    expect(new Set(photos.map((p) => p.documentId))).toEqual(
      new Set([docA, docB]),
    );

    const fetched = await svc.getById(tenantId, squawk.id);
    expect(fetched.photos).toHaveLength(2);
  });

  it("rejects a photo belonging to another tenant", async () => {
    const tenantA = await seedTenant(db, "Org A");
    const tenantB = await seedTenant(db, "Org B");
    const ac = await seedAircraft(db, tenantA, "N444D");
    const docB = await seedDocument(db, tenantB, "wrong-tenant.jpg");
    const svc = new SquawkService(db);
    await expect(
      svc.file({
        tenantId: tenantA,
        aircraftId: ac.id,
        description: "Photo from other tenant",
        severity: "informational",
        photoDocumentIds: [docB],
      }),
    ).rejects.toThrow(SquawkPhotoCrossTenantError);

    // No squawk row should have been created.
    const rows = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from squawks where aircraft_id = ${ac.id}`,
    );
    expect(rows.rows[0]!.count).toBe("0");
  });

  it("listOpenGroundingForAircraft returns only open grounding squawks", async () => {
    const tenantId = await seedTenant(db, "Org D");
    const ac = await seedAircraft(db, tenantId, "N555E");
    const svc = new SquawkService(db);

    await svc.file({
      tenantId,
      aircraftId: ac.id,
      description: "Note: nav light bulb getting dim",
      severity: "informational",
    });
    await svc.file({
      tenantId,
      aircraftId: ac.id,
      description: "Hobbs intermittent",
      severity: "deferred",
    });
    const { squawk: grounding } = await svc.file({
      tenantId,
      aircraftId: ac.id,
      description: "Pitot tube blocked",
      severity: "grounding",
    });

    const open = await svc.listOpenGroundingForAircraft(tenantId, ac.id);
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe(grounding.id);

    // Resolve it and ensure it falls out of the open-grounding list.
    await svc.resolve({
      tenantId,
      squawkId: grounding.id,
      resolutionNotes: "Cleaned pitot",
    });
    const stillOpen = await svc.listOpenGroundingForAircraft(tenantId, ac.id);
    expect(stillOpen).toHaveLength(0);
  });

  it("resolve sets status to resolved with resolved_at and is not double-resolvable", async () => {
    const tenantId = await seedTenant(db, "Org E");
    const mechanic = await seedUser(db, "mech@e.test");
    const ac = await seedAircraft(db, tenantId, "N666F");
    const svc = new SquawkService(db);
    const { squawk } = await svc.file({
      tenantId,
      aircraftId: ac.id,
      description: "Stuck flap motor",
      severity: "grounding",
    });
    const resolved = await svc.resolve({
      tenantId,
      squawkId: squawk.id,
      resolvedByUserId: mechanic,
      resolutionNotes: "Replaced motor",
    });
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.resolvedByUserId).toBe(mechanic);
    expect(resolved.resolutionNotes).toBe("Replaced motor");

    await expect(
      svc.resolve({ tenantId, squawkId: squawk.id }),
    ).rejects.toThrow(SquawkAlreadyResolvedError);
  });

  it("db CHECK constraint blocks invalid severity bypass", async () => {
    const tenantId = await seedTenant(db, "Org F");
    const ac = await seedAircraft(db, tenantId, "N777G");
    await expect(
      db.execute(sql`
        insert into squawks
          (tenant_id, aircraft_id, description, occurred_at, severity)
        values
          (${tenantId}, ${ac.id}, 'bypass', now(), 'critical')
      `),
    ).rejects.toThrow(/squawks_severity_check/);
  });
});
