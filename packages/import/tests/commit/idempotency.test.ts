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
 * PMB-161 / C5 idempotency. Acceptance text: "Idempotent on
 * (import_job_id, source_row_number) — retrying a committed job is a
 * no-op." That has two halves:
 *
 *   1. A second call after a successful commit returns
 *      `alreadyCommitted: true` and produces NO additional live rows.
 *   2. The boundary assertion (CTO guard) confirms validation_status
 *      'committed' rows are not re-processed on replay.
 */
describe("PMB-161 C5 commit pipeline — idempotent retry", () => {
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

  it("returns alreadyCommitted=true on replay and does not double-insert", async () => {
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
        registration: "N42424",
        make: "Beechcraft",
        model: "Bonanza",
        serialNumber: "BB-1",
        category: "standard",
        aircraftClass: "airplane",
        airframeTotalTime: 0,
        timeSource: "hobbs",
      },
    });

    const first = await service.commitImportJob({
      tenantId: fixtures.tenantId,
      userId: fixtures.userId,
      regimeId: fixtures.regimeId,
      importJobId,
    });
    expect(first.alreadyCommitted).toBe(false);
    expect(first.rowsCommitted).toBe(1);

    const second = await service.commitImportJob({
      tenantId: fixtures.tenantId,
      userId: fixtures.userId,
      regimeId: fixtures.regimeId,
      importJobId,
    });
    expect(second.alreadyCommitted).toBe(true);
    expect(second.rowsCommitted).toBe(1);

    // Exactly one live aircraft for the staged row.
    const aircraft = await db.execute<{ id: string }>(sql`
      select id from aircraft where source_import_row_id = ${stagedRowId}::uuid
    `);
    expect(aircraft.rows).toHaveLength(1);

    // Staging row still committed; no orphan duplicates.
    const stagedRows = await db.execute<{
      id: string;
      validation_status: string;
    }>(sql`
      select id, validation_status
        from import_job_rows where import_job_id = ${importJobId}::uuid
    `);
    expect(stagedRows.rows).toHaveLength(1);
    expect(stagedRows.rows[0]!.validation_status).toBe("committed");
  });
});
