import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestSuite, type TestDb } from "@ga/db";

import {
  IngestionService,
  ImportJobCommitFailedError,
} from "../../src/index.js";
import {
  seedFixtures,
  seedJob,
  seedRow,
  type FixtureSeed,
} from "./fixtures.js";

/**
 * PMB-161 / C5 mid-batch failure → whole-tx rollback. The CTO's
 * boundary-assertion guarantee: if anything between the first INSERT
 * and the state flip fails, the tx unwinds completely. Specifically:
 *   * no live rows survive
 *   * no staging row carries a committed_record_id
 *   * the job header has NOT moved to 'committed'
 *   * a SEPARATE recording tx flips state→'failed' with an error_summary
 *
 * The injected failure: row 2 in the batch carries a target_table the
 * inserter can resolve (aircraft) but a duplicate registration so the
 * unique index trips. Row 1 (a valid aircraft) is in the same tx and
 * must roll back too.
 */
describe("PMB-161 C5 commit pipeline — mid-batch failure rolls back", () => {
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

  it("rolls back every live INSERT when row 2 trips a UNIQUE constraint", async () => {
    fixtures = await seedFixtures(db);
    const importJobId = await seedJob(db, {
      tenantId: fixtures.tenantId,
      userId: fixtures.userId,
      importKind: "aircraft",
      sourceFilename: "aircraft.csv",
    });

    // Row 1: a fresh aircraft. Will INSERT cleanly when isolated.
    const row1Id = await seedRow(db, {
      tenantId: fixtures.tenantId,
      importJobId,
      sourceRowNumber: 1,
      targetTable: "aircraft",
      mapped: {
        regimeId: fixtures.regimeId,
        registration: "N11111",
        make: "Cessna",
        model: "172",
        serialNumber: "SN-001-NEW",
        category: "standard",
        aircraftClass: "airplane",
        airframeTotalTime: 0,
        timeSource: "hobbs",
      },
    });

    // Row 2: registration COLLIDES with the seeded aircraft so the
    // partial unique index on (tenant_id, lower(registration)) trips
    // mid-batch. The single-tx contract must roll row 1 back too.
    const row2Id = await seedRow(db, {
      tenantId: fixtures.tenantId,
      importJobId,
      sourceRowNumber: 2,
      targetTable: "aircraft",
      mapped: {
        regimeId: fixtures.regimeId,
        // Same registration as the seeded fixture aircraft → duplicate.
        registration: fixtures.registration,
        make: "Cessna",
        model: "172",
        serialNumber: "SN-COLLIDE",
        category: "standard",
        aircraftClass: "airplane",
        airframeTotalTime: 0,
        timeSource: "hobbs",
      },
    });

    await expect(
      service.commitImportJob({
        tenantId: fixtures.tenantId,
        userId: fixtures.userId,
        regimeId: fixtures.regimeId,
        importJobId,
      }),
    ).rejects.toBeInstanceOf(ImportJobCommitFailedError);

    // No live aircraft for either staged row — full rollback.
    const aircraftFromRow1 = await db.execute<{ id: string }>(sql`
      select id from aircraft where source_import_row_id = ${row1Id}::uuid
    `);
    expect(aircraftFromRow1.rows).toHaveLength(0);
    const aircraftFromRow2 = await db.execute<{ id: string }>(sql`
      select id from aircraft where source_import_row_id = ${row2Id}::uuid
    `);
    expect(aircraftFromRow2.rows).toHaveLength(0);

    // No staging row carries a committed_record_id.
    const staged = await db.execute<{
      committed_record_id: string | null;
      validation_status: string;
    }>(sql`
      select committed_record_id, validation_status
        from import_job_rows where import_job_id = ${importJobId}::uuid
       order by source_row_number
    `);
    expect(staged.rows).toHaveLength(2);
    expect(staged.rows.every((r) => r.committed_record_id === null)).toBe(true);
    // We didn't flip rows to 'committed' (or any other partial state).
    expect(staged.rows.every((r) => r.validation_status === "valid")).toBe(
      true,
    );

    // Job is now 'failed' (recorded by the second tx) with a summary.
    const job = await db.execute<{
      state: string;
      error_summary: { code: string; message: string } | null;
      committed_at: string | null;
    }>(sql`
      select state, error_summary, committed_at
        from import_jobs where id = ${importJobId}::uuid
    `);
    expect(job.rows[0]!.state).toBe("failed");
    expect(job.rows[0]!.committed_at).toBeNull();
    expect(job.rows[0]!.error_summary).not.toBeNull();
    expect(job.rows[0]!.error_summary!.message).toMatch(/aircraft|registration|unique/i);
  });
});
