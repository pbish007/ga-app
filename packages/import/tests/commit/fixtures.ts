import { sql } from "drizzle-orm";

import type { TestDb } from "@ga/db";

/**
 * Shared fixture surface for the C5 commit-pipeline integration
 * tests (PMB-161). Each helper inserts the minimum it needs to leave
 * the database in a state where the next helper succeeds.
 *
 * IDs are returned so tests can later assert against them; nothing
 * here uses RLS-scoped roles — fixture writes go in as the bootstrap
 * superuser, then the commit-pipeline code re-enters the tenant
 * context (`tenant_app` + GUC) inside its own transaction.
 */
export interface FixtureSeed {
  tenantId: string;
  userId: string;
  regimeId: string;
  /** Active A&P credential for the seeded user. Surfaces sign-off resolution. */
  credentialId: string;
  /** The certificate number the seeded credential carries. */
  certificateNumber: string;
  /** Pre-existing aircraft for maintenance / flight-time imports. */
  aircraftId: string;
  /** Pre-existing aircraft's registration ("N12345"). */
  registration: string;
}

export async function seedFixtures(
  db: TestDb,
  overrides: Partial<{ certificateNumber: string; registration: string }> = {},
): Promise<FixtureSeed> {
  const tenantId = "11111111-1111-1111-1111-111111111111";
  const userId = "22222222-2222-2222-2222-222222222222";
  const certificateNumber = overrides.certificateNumber ?? "AP-1234567";
  const registration = overrides.registration ?? "N12345";

  // FAA regime is seeded by migration 0001.
  const regime = await db.execute<{ id: string }>(
    sql`select id from regimes where code = 'FAA'`,
  );
  const regimeId = regime.rows[0]!.id;

  await db.execute(sql`
    insert into organizations (id, name, org_type, default_regime_id)
    values (${tenantId}::uuid, 'tenantA', 'owner', ${regimeId}::uuid)
  `);

  await db.execute(sql`
    insert into users (id, email)
    values (${userId}::uuid, 'mechanic@example.test')
  `);

  await db.execute(sql`
    insert into organization_memberships (tenant_id, user_id, role)
    values (${tenantId}::uuid, ${userId}::uuid, 'mechanic')
  `);

  // A&P credential type is seeded by migration 0001 under code 'ap'.
  const apType = await db.execute<{ id: string }>(sql`
    select id from regime_credential_types where regime_id = ${regimeId} and code = 'ap'
  `);
  const apCredentialTypeId = apType.rows[0]!.id;
  const credential = await db.execute<{ id: string }>(sql`
    insert into user_credentials
      (user_id, regime_credential_type_id, certificate_number, issued_on)
    values (${userId}::uuid, ${apCredentialTypeId}::uuid, ${certificateNumber}, '2020-01-01')
    returning id
  `);
  const credentialId = credential.rows[0]!.id;

  // One pre-existing aircraft so maintenance/flight-time imports
  // have something to anchor against.
  const aircraft = await db.execute<{ id: string }>(sql`
    insert into aircraft
      (tenant_id, regime_id, registration, make, model, serial_number,
       category, aircraft_class, airframe_total_time, time_source)
    values
      (${tenantId}::uuid, ${regimeId}::uuid, ${registration}, 'Cessna', '172',
       'SN-001', 'standard', 'airplane', 1200.0, 'hobbs')
    returning id
  `);
  const aircraftId = aircraft.rows[0]!.id;

  return {
    tenantId,
    userId,
    regimeId,
    credentialId,
    certificateNumber,
    aircraftId,
    registration,
  };
}

export interface SeededJobOpts {
  tenantId: string;
  userId: string;
  importKind: string;
  sourceFilename: string;
  state?: "pending" | "validating" | "ready" | "committing" | "committed";
}

/**
 * Insert an `import_jobs` header in the desired state. Tests bypass
 * the parse/validate flow and stage rows directly so the assertions
 * stay focused on the C5 commit transaction itself.
 */
export async function seedJob(
  db: TestDb,
  opts: SeededJobOpts,
): Promise<string> {
  const state = opts.state ?? "ready";
  const result = await db.execute<{ id: string }>(sql`
    insert into import_jobs
      (tenant_id, state, import_kind, source_filename, created_by_user_id)
    values
      (${opts.tenantId}::uuid, ${state}, ${opts.importKind},
       ${opts.sourceFilename}, ${opts.userId}::uuid)
    returning id
  `);
  return result.rows[0]!.id;
}

export interface SeededRowOpts {
  tenantId: string;
  importJobId: string;
  sourceRowNumber: number;
  targetTable:
    | "aircraft"
    | "maintenance_entries"
    | "components"
    | "flight_time_entries";
  mapped: Record<string, unknown>;
  validationStatus?: "pending" | "valid" | "invalid" | "committed";
}

export async function seedRow(
  db: TestDb,
  opts: SeededRowOpts,
): Promise<string> {
  const status = opts.validationStatus ?? "valid";
  const result = await db.execute<{ id: string }>(sql`
    insert into import_job_rows
      (tenant_id, import_job_id, source_row_number,
       source_payload, mapped_payload, target_table, validation_status)
    values
      (${opts.tenantId}::uuid, ${opts.importJobId}::uuid, ${opts.sourceRowNumber},
       ${JSON.stringify(opts.mapped)}::jsonb,
       ${JSON.stringify(opts.mapped)}::jsonb,
       ${opts.targetTable}, ${status})
    returning id
  `);
  return result.rows[0]!.id;
}
