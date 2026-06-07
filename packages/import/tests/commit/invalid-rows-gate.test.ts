import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestSuite, type TestDb } from "@ga/db";

import {
  IngestionService,
  ImportJobCommitFailedError,
  ImportJobHasInvalidRowsError,
} from "../../src/index.js";
import { seedFixtures, seedJob, seedRow, type FixtureSeed } from "./fixtures.js";

/**
 * PMB-201 — the invalid-rows gate is a precondition failure, not a
 * mid-tx crash. The commit pipeline must re-throw
 * ImportJobHasInvalidRowsError directly so the HTTP layer can surface
 * 422 and the job stays in 'ready' for retry. Wrapping it in
 * ImportJobCommitFailedError (the rollback-recording path) is incorrect
 * because no live rows were written and no inserter actually failed —
 * the gate fired before any INSERT.
 */
describe("PMB-201 C5 commit pipeline — invalid-rows gate bypasses outer catch", () => {
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

  it("re-throws ImportJobHasInvalidRowsError directly and leaves state='ready'", async () => {
    fixtures = await seedFixtures(db);
    const importJobId = await seedJob(db, {
      tenantId: fixtures.tenantId,
      userId: fixtures.userId,
      importKind: "aircraft",
      sourceFilename: "aircraft.csv",
    });

    // One valid row + one invalid row. Even one invalid row should
    // trip the gate; the valid row never reaches its inserter.
    await seedRow(db, {
      tenantId: fixtures.tenantId,
      importJobId,
      sourceRowNumber: 1,
      targetTable: "aircraft",
      validationStatus: "valid",
      mapped: {
        regimeId: fixtures.regimeId,
        registration: "N99001",
        make: "Cessna",
        model: "172",
        serialNumber: "SN-GATE-1",
        category: "standard",
        aircraftClass: "airplane",
        airframeTotalTime: 0,
        timeSource: "hobbs",
      },
    });
    await seedRow(db, {
      tenantId: fixtures.tenantId,
      importJobId,
      sourceRowNumber: 2,
      targetTable: "aircraft",
      validationStatus: "invalid",
      mapped: {
        regimeId: fixtures.regimeId,
        registration: "ZZBAD",
        make: "Cessna",
        model: "172",
        serialNumber: "SN-GATE-2",
        category: "standard",
        aircraftClass: "airplane",
        airframeTotalTime: 0,
        timeSource: "hobbs",
      },
    });

    // The pipeline rejects with the raw gate error — NOT wrapped in
    // ImportJobCommitFailedError. The HTTP handler depends on this
    // discriminator to return 422.
    let caught: unknown;
    try {
      await service.commitImportJob({
        tenantId: fixtures.tenantId,
        userId: fixtures.userId,
        regimeId: fixtures.regimeId,
        importJobId,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ImportJobHasInvalidRowsError);
    expect(caught).not.toBeInstanceOf(ImportJobCommitFailedError);
    expect((caught as ImportJobHasInvalidRowsError).code).toBe(
      "IMPORT_JOB_HAS_INVALID_ROWS",
    );

    // Job header stayed in 'ready' (not flipped to 'failed') and no
    // error_summary was stamped — the operator can fix the bad row
    // and retry the commit without a state reset.
    const job = await db.execute<{
      state: string;
      error_summary: unknown;
      committed_at: string | null;
    }>(sql`
      select state, error_summary, committed_at
        from import_jobs where id = ${importJobId}::uuid
    `);
    expect(job.rows[0]!.state).toBe("ready");
    expect(job.rows[0]!.error_summary).toBeNull();
    expect(job.rows[0]!.committed_at).toBeNull();

    // No live aircraft were inserted for the valid row either — the
    // gate fires before any INSERT runs.
    const live = await db.execute<{ count: string }>(sql`
      select count(*)::text as count
        from aircraft where registration = 'N99001'
    `);
    expect(Number(live.rows[0]!.count)).toBe(0);
  });
});
