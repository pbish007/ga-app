import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestSuite, type TestDb } from "@ga/db";

import {
  IngestionService,
  ManualRowValidationError,
} from "../../src/index.js";
import { seedFixtures, type FixtureSeed } from "./fixtures.js";

/**
 * PMB-161 acceptance: the manual reuse path enters the same validator
 * + writes a single-row job. The audit trail must be identical to a
 * one-row spreadsheet import: live row carries `source_import_row_id`
 * back to a staging row that lives under a `committed` job.
 */
describe("PMB-161 C5 commit pipeline — manual row reuse", () => {
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

  it("writes a one-row import job and a live maintenance entry in one tx", async () => {
    fixtures = await seedFixtures(db);

    const result = await service.commitManualRow({
      tenantId: fixtures.tenantId,
      userId: fixtures.userId,
      regimeId: fixtures.regimeId,
      regimeCode: "FAA",
      entity: "maintenance_entry",
      mapped: {
        aircraftId: fixtures.aircraftId,
        entryType: "annual_inspection",
        workPerformed: "Annual inspection complete; logbook entry transcribed",
        performedOn: "2025-06-01",
        aircraftTotalTime: 1280.0,
        signedAt: "2025-06-01T18:00:00Z",
        signedByCertificateNumber: fixtures.certificateNumber,
        rtsTemplateCode: "annual",
      },
    });

    expect(result).toMatchObject({
      state: "committed",
      rowsCommitted: 1,
      alreadyCommitted: false,
    });
    expect(result.recordId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // Live maintenance entry exists with the traceability hook.
    const entry = await db.execute<{
      id: string;
      source_import_row_id: string;
      signed_by_user_id: string;
      rts_rendered_body: string;
    }>(sql`
      select id, source_import_row_id, signed_by_user_id, rts_rendered_body
        from maintenance_entries where id = ${result.recordId}::uuid
    `);
    expect(entry.rows).toHaveLength(1);
    expect(entry.rows[0]!.source_import_row_id).not.toBeNull();
    expect(entry.rows[0]!.signed_by_user_id).toBe(fixtures.userId);

    // The single-row staging job is fully realized.
    const job = await db.execute<{
      id: string;
      state: string;
      import_kind: string;
      source_filename: string;
      row_count: number;
    }>(sql`
      select id, state, import_kind, source_filename, row_count
        from import_jobs where id = ${result.importJobId}::uuid
    `);
    expect(job.rows[0]!.state).toBe("committed");
    expect(job.rows[0]!.import_kind).toBe("manual_maintenance_entry");
    expect(job.rows[0]!.source_filename).toBe("manual_entry:maintenance_entry");

    const stagedRow = await db.execute<{
      id: string;
      validation_status: string;
      committed_record_id: string;
    }>(sql`
      select id, validation_status, committed_record_id
        from import_job_rows where import_job_id = ${result.importJobId}::uuid
    `);
    expect(stagedRow.rows).toHaveLength(1);
    expect(stagedRow.rows[0]!.validation_status).toBe("committed");
    expect(stagedRow.rows[0]!.committed_record_id).toBe(result.recordId);
    expect(stagedRow.rows[0]!.id).toBe(entry.rows[0]!.source_import_row_id);
  });

  it("rejects a manual row that fails C4 validation BEFORE any live write", async () => {
    fixtures = await seedFixtures(db);

    await expect(
      service.commitManualRow({
        tenantId: fixtures.tenantId,
        userId: fixtures.userId,
        regimeId: fixtures.regimeId,
        regimeCode: "FAA",
        entity: "maintenance_entry",
        mapped: {
          aircraftId: fixtures.aircraftId,
          entryType: "annual_inspection",
          workPerformed: "Missing sign-off shape",
          performedOn: "2025-06-01",
          aircraftTotalTime: 1280.0,
          // No signedAt / certificate / rtsTemplateCode → UNSIGNED_HISTORICAL
        },
      }),
    ).rejects.toBeInstanceOf(ManualRowValidationError);

    // No live maintenance entry slipped through.
    const entries = await db.execute<{ id: string }>(sql`
      select id from maintenance_entries where aircraft_id = ${fixtures.aircraftId}::uuid
    `);
    expect(entries.rows).toHaveLength(0);

    // No staging job left behind either (the tx rolled back).
    const jobs = await db.execute<{ id: string }>(sql`
      select id from import_jobs where tenant_id = ${fixtures.tenantId}::uuid
    `);
    expect(jobs.rows).toHaveLength(0);
  });
});
