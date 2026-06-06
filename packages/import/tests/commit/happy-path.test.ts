import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestSuite, type TestDb } from "@ga/db";

import { IngestionService } from "../../src/index.js";
import {
  seedFixtures,
  seedJob,
  seedRow,
  type FixtureSeed,
} from "./fixtures.js";

/**
 * PMB-161 / C5 happy paths — one per V1 entity. Verifies the single
 * commit transaction:
 *   * writes one live row per staged row with `source_import_row_id`
 *     pointing back at the staging row
 *   * stamps the staging row's `committed_record_id` + `validation_status`
 *   * flips `import_jobs.state` to 'committed' atomically
 *   * captures committed_at + committed_by_user_id
 */
describe("PMB-161 C5 commit pipeline — happy path per entity", () => {
  let db: TestDb;
  let reset: () => Promise<void>;
  let fixtures: FixtureSeed;
  let service: IngestionService;

  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
    service = new IngestionService(db);
  });

  afterEach(async () => {
    await reset();
  });

  it("commits a single aircraft row end-to-end", async () => {
    fixtures = await seedFixtures(db);
    const importJobId = await seedJob(db, {
      tenantId: fixtures.tenantId,
      userId: fixtures.userId,
      importKind: "aircraft",
      sourceFilename: "aircraft.csv",
    });
    const stagedRowId = await seedRow(db, {
      tenantId: fixtures.tenantId,
      importJobId,
      sourceRowNumber: 1,
      targetTable: "aircraft",
      mapped: {
        regimeId: fixtures.regimeId,
        registration: "N99999",
        make: "Piper",
        model: "PA28",
        serialNumber: "SN-XYZ",
        category: "standard",
        aircraftClass: "airplane",
        airframeTotalTime: 0,
        timeSource: "hobbs",
      },
    });

    const result = await service.commitImportJob({
      tenantId: fixtures.tenantId,
      userId: fixtures.userId,
      regimeId: fixtures.regimeId,
      importJobId,
    });

    expect(result).toMatchObject({
      state: "committed",
      rowsCommitted: 1,
      alreadyCommitted: false,
    });

    // Live row exists with the traceability FK.
    const aircraft = await db.execute<{
      id: string;
      registration: string;
      source_import_row_id: string;
    }>(sql`
      select id, registration, source_import_row_id
        from aircraft
       where source_import_row_id = ${stagedRowId}::uuid
    `);
    expect(aircraft.rows).toHaveLength(1);
    expect(aircraft.rows[0]!.registration).toBe("N99999");

    // Staging row carries the live record id + committed status.
    const staged = await db.execute<{
      committed_record_id: string;
      validation_status: string;
    }>(sql`
      select committed_record_id, validation_status
        from import_job_rows where id = ${stagedRowId}::uuid
    `);
    expect(staged.rows[0]!.committed_record_id).toBe(aircraft.rows[0]!.id);
    expect(staged.rows[0]!.validation_status).toBe("committed");

    // Job header flipped.
    const job = await db.execute<{
      state: string;
      committed_at: string | null;
      committed_by_user_id: string | null;
    }>(sql`
      select state, committed_at, committed_by_user_id
        from import_jobs where id = ${importJobId}::uuid
    `);
    expect(job.rows[0]!.state).toBe("committed");
    expect(job.rows[0]!.committed_at).not.toBeNull();
    expect(job.rows[0]!.committed_by_user_id).toBe(fixtures.userId);
  });

  it("commits a maintenance entry already signed (sign-off shape preserved)", async () => {
    fixtures = await seedFixtures(db);
    const importJobId = await seedJob(db, {
      tenantId: fixtures.tenantId,
      userId: fixtures.userId,
      importKind: "maintenance_entries",
      sourceFilename: "history.csv",
    });
    const stagedRowId = await seedRow(db, {
      tenantId: fixtures.tenantId,
      importJobId,
      sourceRowNumber: 1,
      targetTable: "maintenance_entries",
      mapped: {
        aircraftId: fixtures.aircraftId,
        entryType: "maintenance",
        workPerformed: "Replaced left magneto",
        performedOn: "2025-05-10",
        aircraftTotalTime: 1234.5,
        signedAt: "2025-05-10T15:30:00Z",
        signedByCertificateNumber: fixtures.certificateNumber,
        rtsTemplateCode: "return_to_service_maintenance",
      },
    });

    await service.commitImportJob({
      tenantId: fixtures.tenantId,
      userId: fixtures.userId,
      regimeId: fixtures.regimeId,
      importJobId,
    });

    // Live row exists with sign-off shape fully populated AND the
    // immutability trigger considers it frozen.
    const entry = await db.execute<{
      id: string;
      signed_at: string | null;
      signed_by_user_id: string | null;
      signed_by_credential_id: string | null;
      rts_template_id: string | null;
      rts_rendered_body: string | null;
      source_import_row_id: string | null;
    }>(sql`
      select id, signed_at, signed_by_user_id, signed_by_credential_id,
             rts_template_id, rts_rendered_body, source_import_row_id
        from maintenance_entries
       where source_import_row_id = ${stagedRowId}::uuid
    `);
    expect(entry.rows).toHaveLength(1);
    const row = entry.rows[0]!;
    expect(row.signed_at).not.toBeNull();
    expect(row.signed_by_user_id).toBe(fixtures.userId);
    expect(row.signed_by_credential_id).toBe(fixtures.credentialId);
    expect(row.rts_template_id).not.toBeNull();
    expect(row.rts_rendered_body).toContain("Replaced left magneto");

    // Update on a signed row must fail (immutability trigger).
    await expect(
      db.execute(sql`
        update maintenance_entries
           set work_performed = 'tampered'
         where id = ${row.id}::uuid
      `),
    ).rejects.toThrow(/signed and immutable/i);
  });

  it("commits a component row end-to-end", async () => {
    fixtures = await seedFixtures(db);
    const importJobId = await seedJob(db, {
      tenantId: fixtures.tenantId,
      userId: fixtures.userId,
      importKind: "components",
      sourceFilename: "components.csv",
    });
    const stagedRowId = await seedRow(db, {
      tenantId: fixtures.tenantId,
      importJobId,
      sourceRowNumber: 1,
      targetTable: "components",
      mapped: {
        kind: "engine",
        serialNumber: "ENG-ABC-001",
        make: "Lycoming",
        model: "O-360",
        tboHours: 2000,
      },
    });

    await service.commitImportJob({
      tenantId: fixtures.tenantId,
      userId: fixtures.userId,
      regimeId: fixtures.regimeId,
      importJobId,
    });

    const components = await db.execute<{
      id: string;
      kind: string;
      tbo_hours: string;
      source_import_row_id: string;
    }>(sql`
      select id, kind, tbo_hours, source_import_row_id
        from components
       where source_import_row_id = ${stagedRowId}::uuid
    `);
    expect(components.rows).toHaveLength(1);
    expect(components.rows[0]!.kind).toBe("engine");
    expect(Number(components.rows[0]!.tbo_hours)).toBe(2000);
  });

  it("commits two flight_time_entries for the same aircraft and advances airframe TT", async () => {
    fixtures = await seedFixtures(db);
    const importJobId = await seedJob(db, {
      tenantId: fixtures.tenantId,
      userId: fixtures.userId,
      importKind: "flight_time_entries",
      sourceFilename: "hours.csv",
    });
    await seedRow(db, {
      tenantId: fixtures.tenantId,
      importJobId,
      sourceRowNumber: 1,
      targetTable: "flight_time_entries",
      mapped: {
        aircraftId: fixtures.aircraftId,
        airframeTimeNew: 1300.5,
      },
    });
    await seedRow(db, {
      tenantId: fixtures.tenantId,
      importJobId,
      sourceRowNumber: 2,
      targetTable: "flight_time_entries",
      mapped: {
        aircraftId: fixtures.aircraftId,
        airframeTimeNew: 1400.0,
      },
    });

    const result = await service.commitImportJob({
      tenantId: fixtures.tenantId,
      userId: fixtures.userId,
      regimeId: fixtures.regimeId,
      importJobId,
    });
    expect(result.rowsCommitted).toBe(2);

    // The DB trigger advances aircraft.airframe_total_time per row.
    const aircraft = await db.execute<{ airframe_total_time: string }>(sql`
      select airframe_total_time from aircraft where id = ${fixtures.aircraftId}::uuid
    `);
    expect(Number(aircraft.rows[0]!.airframe_total_time)).toBe(1400.0);
  });
});
