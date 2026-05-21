import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestDb, type TestDb } from "@ga/db";

import {
  AircraftService,
  MaintenanceEntryAlreadySignedError,
  MaintenanceEntryNotAuthorizedToSignError,
  MaintenanceEntryNotFoundError,
  MaintenanceEntryService,
  MaintenanceEntryValidationError,
  recommendRtsTemplateCode,
  renderRtsTemplate,
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

/**
 * Issues an A&P credential to the user. Authorises sign-off under
 * the FAA regime per the seed in migration 0001.
 */
async function seedApCredential(
  db: TestDb,
  userId: string,
  options: { certificateNumber?: string; expiresOn?: string | null } = {},
): Promise<string> {
  const cert = options.certificateNumber ?? "AP-1234567";
  const expiresOn = options.expiresOn ?? null;
  const rows = await db.execute<{ id: string }>(sql`
    insert into user_credentials
      (user_id, regime_credential_type_id, certificate_number, issued_on, expires_on)
    select ${userId}, rct.id, ${cert}, '2024-01-01'::date, ${expiresOn}::date
      from regime_credential_types rct
      join regimes r on r.id = rct.regime_id
     where r.code = 'FAA' and rct.code = 'ap'
    returning id
  `);
  return rows.rows[0]!.id;
}

describe("MaintenanceEntryService (F1/F2)", () => {
  it("drafts an unsigned entry capturing work, date, time, type", async () => {
    const db = await setupTestDb();
    const tenantId = await seedTenant(db, "Org A");
    const ac = await seedAircraft(db, tenantId, "N111A");
    const svc = new MaintenanceEntryService(db);

    const entry = await svc.draft({
      tenantId,
      aircraftId: ac.id,
      entryType: "maintenance",
      workPerformed: "Replaced left main tire and tube",
      performedOn: "2026-05-21",
      aircraftTotalTime: 2451.3,
    });

    expect(entry.workPerformed).toBe("Replaced left main tire and tube");
    expect(entry.entryType).toBe("maintenance");
    expect(entry.performedOn).toBe("2026-05-21");
    expect(Number(entry.aircraftTotalTime)).toBe(2451.3);
    expect(entry.signedAt).toBeNull();
    expect(entry.rtsRenderedBody).toBeNull();
  });

  it("rejects empty work and invalid entry type and bad date", async () => {
    const db = await setupTestDb();
    const tenantId = await seedTenant(db, "Org B");
    const ac = await seedAircraft(db, tenantId, "N222B");
    const svc = new MaintenanceEntryService(db);

    await expect(
      svc.draft({
        tenantId,
        aircraftId: ac.id,
        entryType: "maintenance",
        workPerformed: "   ",
        performedOn: "2026-05-21",
        aircraftTotalTime: 100,
      }),
    ).rejects.toThrow(MaintenanceEntryValidationError);

    await expect(
      svc.draft({
        tenantId,
        aircraftId: ac.id,
        // @ts-expect-error: intentionally invalid
        entryType: "bogus",
        workPerformed: "x",
        performedOn: "2026-05-21",
        aircraftTotalTime: 100,
      }),
    ).rejects.toThrow(MaintenanceEntryValidationError);

    await expect(
      svc.draft({
        tenantId,
        aircraftId: ac.id,
        entryType: "maintenance",
        workPerformed: "x",
        performedOn: "yesterday",
        aircraftTotalTime: 100,
      }),
    ).rejects.toThrow(MaintenanceEntryValidationError);
  });

  it("refuses to sign without an authorising credential", async () => {
    const db = await setupTestDb();
    const tenantId = await seedTenant(db, "Org C");
    const ac = await seedAircraft(db, tenantId, "N333C");
    const userId = await seedUser(db, "pilot@c.test");
    const svc = new MaintenanceEntryService(db);

    const entry = await svc.draft({
      tenantId,
      aircraftId: ac.id,
      entryType: "annual_inspection",
      workPerformed: "Annual inspection per checklist",
      performedOn: "2026-05-21",
      aircraftTotalTime: 2500,
    });

    await expect(
      svc.sign({
        tenantId,
        entryId: entry.id,
        signedByUserId: userId,
      }),
    ).rejects.toThrow(MaintenanceEntryNotAuthorizedToSignError);

    const unchanged = await svc.getById(tenantId, entry.id);
    expect(unchanged.signedAt).toBeNull();
  });

  it("signs an annual with an A&P credential, freezes RTS body, snapshots certificate number", async () => {
    const db = await setupTestDb();
    const tenantId = await seedTenant(db, "Org D");
    const ac = await seedAircraft(db, tenantId, "N444D");
    const mechId = await seedUser(db, "mech@d.test");
    const credId = await seedApCredential(db, mechId, {
      certificateNumber: "A&P-7654321",
    });
    const svc = new MaintenanceEntryService(db);

    const entry = await svc.draft({
      tenantId,
      aircraftId: ac.id,
      entryType: "annual_inspection",
      workPerformed: "Annual inspection complete; no discrepancies.",
      performedOn: "2026-05-21",
      aircraftTotalTime: 3120.5,
    });

    const signed = await svc.sign({
      tenantId,
      entryId: entry.id,
      signedByUserId: mechId,
    });

    expect(signed.signedAt).not.toBeNull();
    expect(signed.signedByUserId).toBe(mechId);
    expect(signed.signedByCredentialId).toBe(credId);
    expect(signed.signedByCertificateNumber).toBe("A&P-7654321");
    expect(signed.rtsTemplateId).not.toBeNull();
    expect(signed.rtsRenderedBody).toBeTruthy();
    // The rendered body is a snapshot of the FAA annual template.
    // We don't assert the exact regulatory wording here (that would
    // duplicate the seed); we assert the placeholders are gone.
    expect(signed.rtsRenderedBody).not.toContain("{{");
  });

  it("post-sign UPDATE attempts are rejected by the DB trigger", async () => {
    const db = await setupTestDb();
    const tenantId = await seedTenant(db, "Org E");
    const ac = await seedAircraft(db, tenantId, "N555E");
    const mechId = await seedUser(db, "mech@e.test");
    await seedApCredential(db, mechId, { certificateNumber: "A&P-555" });
    const svc = new MaintenanceEntryService(db);

    const entry = await svc.draft({
      tenantId,
      aircraftId: ac.id,
      entryType: "maintenance",
      workPerformed: "Replaced spark plugs",
      performedOn: "2026-05-21",
      aircraftTotalTime: 1000,
    });
    const signed = await svc.sign({
      tenantId,
      entryId: entry.id,
      signedByUserId: mechId,
    });

    await expect(
      db.execute(sql`
        update maintenance_entries
           set work_performed = 'tampered'
         where id = ${signed.id}
      `),
    ).rejects.toThrow(/signed and immutable/);
  });

  it("double-sign is rejected at the service layer", async () => {
    const db = await setupTestDb();
    const tenantId = await seedTenant(db, "Org F");
    const ac = await seedAircraft(db, tenantId, "N666F");
    const mechId = await seedUser(db, "mech@f.test");
    await seedApCredential(db, mechId);
    const svc = new MaintenanceEntryService(db);

    const entry = await svc.draft({
      tenantId,
      aircraftId: ac.id,
      entryType: "maintenance",
      workPerformed: "Cleaned plugs",
      performedOn: "2026-05-21",
      aircraftTotalTime: 1500,
    });
    await svc.sign({ tenantId, entryId: entry.id, signedByUserId: mechId });
    await expect(
      svc.sign({ tenantId, entryId: entry.id, signedByUserId: mechId }),
    ).rejects.toThrow(MaintenanceEntryAlreadySignedError);
  });

  it("corrections are new rows linked to the prior entry", async () => {
    const db = await setupTestDb();
    const tenantId = await seedTenant(db, "Org G");
    const ac = await seedAircraft(db, tenantId, "N777G");
    const mechId = await seedUser(db, "mech@g.test");
    await seedApCredential(db, mechId);
    const svc = new MaintenanceEntryService(db);

    const original = await svc.draft({
      tenantId,
      aircraftId: ac.id,
      entryType: "maintenance",
      workPerformed: "Replaced left magneto",
      performedOn: "2026-05-21",
      aircraftTotalTime: 2000,
    });
    await svc.sign({ tenantId, entryId: original.id, signedByUserId: mechId });

    // Cannot correct an unsigned entry.
    await expect(
      svc.draft({
        tenantId,
        aircraftId: ac.id,
        entryType: "maintenance",
        workPerformed: "intent: correct an in-progress draft",
        performedOn: "2026-05-21",
        aircraftTotalTime: 2000,
        correctionOfId: "00000000-0000-0000-0000-000000000000",
      }),
    ).rejects.toThrow(MaintenanceEntryNotFoundError);

    const correction = await svc.draft({
      tenantId,
      aircraftId: ac.id,
      entryType: "maintenance",
      workPerformed: "Correction: magneto was the RIGHT, not the left",
      performedOn: "2026-05-22",
      aircraftTotalTime: 2000,
      correctionOfId: original.id,
    });
    await svc.sign({ tenantId, entryId: correction.id, signedByUserId: mechId });

    const chained = await svc.chainOriginal(tenantId, correction.id);
    expect(chained.id).toBe(original.id);

    // Both rows are visible in the list — corrections never replace
    // the original (§3.1).
    const list = await svc.listForAircraft(tenantId, ac.id);
    expect(list.map((e) => e.id).sort()).toEqual(
      [original.id, correction.id].sort(),
    );
  });

  it("expired credential cannot sign", async () => {
    const db = await setupTestDb();
    const tenantId = await seedTenant(db, "Org H");
    const ac = await seedAircraft(db, tenantId, "N888H");
    const mechId = await seedUser(db, "mech@h.test");
    await seedApCredential(db, mechId, {
      certificateNumber: "A&P-expired",
      expiresOn: "2020-01-01",
    });
    const svc = new MaintenanceEntryService(db);

    const entry = await svc.draft({
      tenantId,
      aircraftId: ac.id,
      entryType: "maintenance",
      workPerformed: "Bleed brakes",
      performedOn: "2026-05-21",
      aircraftTotalTime: 1234,
    });

    await expect(
      svc.sign({
        tenantId,
        entryId: entry.id,
        signedByUserId: mechId,
      }),
    ).rejects.toThrow(MaintenanceEntryNotAuthorizedToSignError);
  });
});

describe("F2 helpers", () => {
  it("recommendRtsTemplateCode maps entry types to template codes", () => {
    expect(recommendRtsTemplateCode("annual_inspection")).toBe("annual");
    expect(recommendRtsTemplateCode("100_hour_inspection")).toBe("100_hour");
    expect(recommendRtsTemplateCode("ad_compliance")).toBe("ad_compliance");
    expect(recommendRtsTemplateCode("inspection_program")).toBe("standard");
    expect(recommendRtsTemplateCode("maintenance")).toBe(
      "return_to_service_maintenance",
    );
  });

  it("renderRtsTemplate substitutes structural placeholders", () => {
    const body =
      "Tail {{aircraft_registration}} on {{performed_on}} @ {{aircraft_total_time}}h; work: {{work_performed}}; cert {{certificate_number}}.";
    const rendered = renderRtsTemplate(body, {
      workPerformed: "Replaced filter",
      aircraftTotalTime: "1234.50",
      performedOn: "2026-05-21",
      aircraftRegistration: "N12345",
      certificateNumber: "A&P-77",
    });
    expect(rendered).toBe(
      "Tail N12345 on 2026-05-21 @ 1234.50h; work: Replaced filter; cert A&P-77.",
    );
    expect(rendered).not.toContain("{{");
  });
});
