import { randomBytes, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";
import postgres from "postgres";

import { schema as dbSchema } from "@ga/db";
import type { AccountsDb } from "@ga/accounts";

/**
 * Bootstrap + demo-seed logic for the MVP board acceptance demo
 * (PMB-61 / PMB-60). Runs server-side against the runtime DATABASE_URL,
 * which is the only place the (write-only / sensitive) production
 * connection string is available.
 *
 * Two responsibilities:
 *   1. `GRANT tenant_app TO current_user` — the role-membership fix that
 *      lets `runAsTenantOnProductionDb` switch into `tenant_app`. Also
 *      shipped as migration 0016 for canonical history; applied here too
 *      because migrate.sh needs the write-only connection string.
 *   2. Seed a deterministic, walkable demo organization.
 *
 * Idempotent: re-running resets the demo org + demo users.
 */

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export const DEMO_ORG_NAME = "Blue Sky Aviation (Demo)";
export const DEMO_USERS = {
  admin: "owner@demo.gaapp.io",
  mechanic: "mechanic@demo.gaapp.io",
  pilot: "pilot@demo.gaapp.io",
} as const;

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export interface BootstrapSeedResult {
  tenantRoleGranted: boolean;
  tenantId: string;
  password: string;
  users: typeof DEMO_USERS;
}

export async function bootstrapAndSeed(
  databaseUrl: string,
  password: string,
): Promise<BootstrapSeedResult> {
  const sql = postgres(databaseUrl, { prepare: false });
  let tenantRoleGranted = false;
  try {
    // ---- (1) Role grants (migration 0016 applied at runtime) ----
    // Membership so the app role may `SET ROLE tenant_app`, plus SELECT on
    // the global regime reference tables the tenant path reads.
    await sql`GRANT tenant_app TO current_user`;
    await sql`GRANT SELECT ON regimes TO tenant_app`;
    await sql`GRANT SELECT ON regime_inspection_program_templates TO tenant_app`;
    await sql`GRANT SELECT ON regime_inspection_program_intervals TO tenant_app`;
    await sql`GRANT SELECT ON regime_credential_types TO tenant_app`;
    await sql`GRANT SELECT ON regime_rts_templates TO tenant_app`;
    await sql`GRANT SELECT ON regime_directive_sources TO tenant_app`;
    await sql`GRANT SELECT ON regime_retention_rules TO tenant_app`;
    await sql`GRANT SELECT (id) ON users TO tenant_app`;
    tenantRoleGranted = true;

    // ---- Lookups (regime catalog is global reference data) ----
    const [regime] = await sql<{ id: string }[]>`
      SELECT id FROM regimes WHERE code = 'FAA' LIMIT 1`;
    if (!regime) throw new Error("FAA regime not found — run migrations first.");
    const regimeId = regime.id;

    const programRows = await sql<{ code: string; id: string }[]>`
      SELECT code, id FROM regime_inspection_program_templates
       WHERE regime_id = ${regimeId}`;
    const programByCode: Record<string, string> = Object.fromEntries(
      programRows.map((r) => [r.code, r.id]),
    );
    for (const code of ["annual", "100_hour", "elt", "transponder"]) {
      if (!programByCode[code]) {
        throw new Error(`inspection program template '${code}' not found`);
      }
    }

    const [iaType] = await sql<{ id: string }[]>`
      SELECT id FROM regime_credential_types
       WHERE regime_id = ${regimeId} AND code = 'ia' LIMIT 1`;
    if (!iaType) throw new Error("IA credential type not found");

    const [rts100] = await sql<{ id: string; body: string }[]>`
      SELECT id, body FROM regime_rts_templates
       WHERE regime_id = ${regimeId} AND code = '100_hour' LIMIT 1`;
    if (!rts100) throw new Error("100_hour RTS template not found");

    const adminHash = await hashPassword(password);
    const mechHash = await hashPassword(password);
    const pilotHash = await hashPassword(password);
    const now = new Date();

    const tenantId = await sql.begin(async (sql) => {
      // ---- Idempotency: remove prior demo data ----
      await sql`DELETE FROM organizations WHERE name = ${DEMO_ORG_NAME}`;
      await sql`
        DELETE FROM users
         WHERE lower(email) IN (${DEMO_USERS.admin}, ${DEMO_USERS.mechanic}, ${DEMO_USERS.pilot})`;

      // ---- Users (global identity) ----
      const [admin] = await sql<{ id: string }[]>`
        INSERT INTO users (email, password_hash, email_verified_at, password_changed_at)
        VALUES (${DEMO_USERS.admin}, ${adminHash}, ${now}, ${now}) RETURNING id`;
      const [mechanic] = await sql<{ id: string }[]>`
        INSERT INTO users (email, password_hash, email_verified_at, password_changed_at)
        VALUES (${DEMO_USERS.mechanic}, ${mechHash}, ${now}, ${now}) RETURNING id`;
      const [pilot] = await sql<{ id: string }[]>`
        INSERT INTO users (email, password_hash, email_verified_at, password_changed_at)
        VALUES (${DEMO_USERS.pilot}, ${pilotHash}, ${now}, ${now}) RETURNING id`;

      // ---- Organization (FAA regime default — K2 seam) ----
      const [org] = await sql<{ id: string }[]>`
        INSERT INTO organizations (name, org_type, default_regime_id)
        VALUES (${DEMO_ORG_NAME}, 'owner', ${regimeId}) RETURNING id`;
      const orgId = org!.id;

      // Set tenant context so FORCE-RLS inserts satisfy policy.
      await sql`SELECT set_config('app.current_tenant_id', ${orgId}, true)`;

      // ---- Memberships ----
      await sql`
        INSERT INTO organization_memberships (tenant_id, user_id, role) VALUES
          (${orgId}, ${admin!.id}, 'admin'),
          (${orgId}, ${mechanic!.id}, 'mechanic'),
          (${orgId}, ${pilot!.id}, 'pilot')`;

      // ---- Mechanic credential (A&P/IA, current) — authorizes sign-off ----
      const [cred] = await sql<{ id: string }[]>`
        INSERT INTO user_credentials
          (user_id, regime_credential_type_id, certificate_number, issued_on, expires_on)
        VALUES (${mechanic!.id}, ${iaType.id}, 'IA-DEMO-4477', '2019-06-01', '2031-06-01')
        RETURNING id`;

      // ---- Aircraft ----
      const airframeTT = 4860.5;
      const [aircraft] = await sql<{ id: string }[]>`
        INSERT INTO aircraft
          (tenant_id, regime_id, registration, make, model, serial_number,
           year_manufactured, category, aircraft_class, airframe_total_time, time_source)
        VALUES (${orgId}, ${regimeId}, 'N172DEMO', 'Cessna', '172S Skyhawk',
                '172S-DEMO-01', 2014, 'airplane', 'single-engine land',
                ${airframeTT}, 'hobbs')
        RETURNING id`;
      const aircraftId = aircraft!.id;

      // ---- Inspection subscriptions ----
      // annual (12 months): complied 400 days ago -> ~35 days OVERDUE.
      await sql`
        INSERT INTO aircraft_inspection_subscriptions
          (tenant_id, aircraft_id, program_id, last_complied_at,
           last_complied_airframe_time, last_complied_cycles)
        VALUES (${orgId}, ${aircraftId}, ${programByCode["annual"]},
                ${daysAgo(400)}, ${airframeTT - 92}, 0)`;
      // 100-hour: anchored 96 h ago -> 4.0 h remaining -> DUE SOON (<10 h).
      await sql`
        INSERT INTO aircraft_inspection_subscriptions
          (tenant_id, aircraft_id, program_id, last_complied_at,
           last_complied_airframe_time, last_complied_cycles)
        VALUES (${orgId}, ${aircraftId}, ${programByCode["100_hour"]},
                ${daysAgo(120)}, ${airframeTT - 96}, 0)`;
      // ELT (12 months): complied 60 days ago -> OK.
      await sql`
        INSERT INTO aircraft_inspection_subscriptions
          (tenant_id, aircraft_id, program_id, last_complied_at,
           last_complied_airframe_time, last_complied_cycles)
        VALUES (${orgId}, ${aircraftId}, ${programByCode["elt"]},
                ${daysAgo(60)}, ${airframeTT - 40}, 0)`;
      // Transponder (24 months): complied 90 days ago -> OK.
      await sql`
        INSERT INTO aircraft_inspection_subscriptions
          (tenant_id, aircraft_id, program_id, last_complied_at,
           last_complied_airframe_time, last_complied_cycles)
        VALUES (${orgId}, ${aircraftId}, ${programByCode["transponder"]},
                ${daysAgo(90)}, ${airframeTT - 60}, 0)`;

      // ---- Flight-time entry (running total) ----
      await sql`
        INSERT INTO flight_time_entries
          (tenant_id, aircraft_id, airframe_time_new, airframe_time_prev, entered_by_user_id)
        VALUES (${orgId}, ${aircraftId}, ${airframeTT}, ${airframeTT - 1.5}, ${pilot!.id})`;

      // ---- Open grounding squawk (aircraft not airworthy) ----
      await sql`
        INSERT INTO squawks
          (tenant_id, aircraft_id, description, occurred_at, reporter_user_id, severity, status)
        VALUES (${orgId}, ${aircraftId},
                'Right main landing gear tire worn beyond service limit; cords visible. Aircraft grounded pending replacement.',
                ${daysAgo(2)}, ${pilot!.id}, 'grounding', 'open')`;

      // ---- Signed maintenance entry (immutable proof / return-to-service) ----
      const signedOn = daysAgo(10);
      await sql`
        INSERT INTO maintenance_entries
          (tenant_id, aircraft_id, entry_type, work_performed, performed_on,
           aircraft_total_time, inspection_program_id, signed_at, signed_by_user_id,
           signed_by_credential_id, signed_by_certificate_number, rts_template_id, rts_rendered_body)
        VALUES (${orgId}, ${aircraftId}, '100_hour_inspection',
                'Completed 100-hour inspection per 14 CFR 91.409(b). Oil and filter change, compression check all cylinders within limits, control rigging verified.',
                ${isoDate(signedOn)}, ${airframeTT - 100}, ${programByCode["100_hour"]},
                ${signedOn}, ${mechanic!.id}, ${cred!.id}, 'IA-DEMO-4477',
                ${rts100.id}, ${rts100.body})`;

      // ---- Draft maintenance entry (sign live during the demo) ----
      await sql`
        INSERT INTO maintenance_entries
          (tenant_id, aircraft_id, entry_type, work_performed, performed_on,
           aircraft_total_time, inspection_program_id)
        VALUES (${orgId}, ${aircraftId}, 'annual_inspection',
                'Annual inspection per 14 CFR 91.409(a). Replaced #2 cylinder, serviced brakes, ELT battery and function check. Ready for return-to-service sign-off.',
                ${isoDate(now)}, ${airframeTT}, ${programByCode["annual"]})`;

      return orgId;
    });

    return { tenantRoleGranted, tenantId, password, users: DEMO_USERS };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Idempotent demo seed for a tenant created via the admin API. Replaces
 * the runtime functionality of the retired `db-seed-demo` GH workflow:
 * given an EXISTING tenant id, drops the tenant's aircraft-scoped demo
 * data (aircraft + subscriptions + flight time + open squawks + draft
 * maintenance entries) and re-inserts the canonical demo aircraft.
 *
 * Unlike {@link bootstrapAndSeed}, this does NOT create users, an org,
 * or memberships — those come from `POST /api/admin/tenants`. The seed
 * relies on the tenant having at least one admin membership; the caller
 * supplies the admin's user id as the squawk reporter so the row's NOT
 * NULL constraint is satisfied without inventing demo users.
 *
 * Re-runs replace the prior aircraft/sub/squawk/entry rows for the
 * tenant — every call lands on the same content shape (one aircraft,
 * four inspection subscriptions in `ok`/`due_soon`/`overdue` states,
 * one open grounding squawk, one draft maintenance entry).
 */
const { aircraft, aircraftInspectionSubscriptions, flightTimeEntries, maintenanceEntries, regimeInspectionProgramTemplates, squawks } = dbSchema;

export interface SeedDemoContentInput {
  db: AccountsDb;
  tenantId: string;
  regimeId: string;
  /** Set as the squawk reporter + flight-time entry author. */
  reporterUserId: string;
  /** Override the clock in tests. */
  now?: () => Date;
}

export interface SeedDemoContentResult {
  aircraftId: string;
}

export async function seedDemoContent(
  input: SeedDemoContentInput,
): Promise<SeedDemoContentResult> {
  const clock = input.now ?? (() => new Date());
  const now = clock();

  const programRows = await input.db
    .select({
      code: regimeInspectionProgramTemplates.code,
      id: regimeInspectionProgramTemplates.id,
    })
    .from(regimeInspectionProgramTemplates)
    .where(eq(regimeInspectionProgramTemplates.regimeId, input.regimeId));
  const programByCode = new Map(programRows.map((r) => [r.code, r.id]));
  for (const code of ["annual", "100_hour", "elt", "transponder"] as const) {
    if (!programByCode.has(code)) {
      throw new Error(
        `regime ${input.regimeId} is missing the '${code}' inspection program template`,
      );
    }
  }

  // ON DELETE CASCADE on aircraft drops subs/flight-time/squawks/entries —
  // one delete per tenant is enough to clear the prior demo state.
  await input.db.delete(aircraft).where(eq(aircraft.tenantId, input.tenantId));

  const airframeTT = 4860.5;
  const ttPrev = (airframeTT - 1.5).toFixed(2);
  const ttCurrent = airframeTT.toFixed(2);
  const day = 24 * 60 * 60 * 1000;
  const daysAgoIso = (n: number) => new Date(now.getTime() - n * day);

  const [createdAircraft] = await input.db
    .insert(aircraft)
    .values({
      tenantId: input.tenantId,
      regimeId: input.regimeId,
      registration: "N172DEMO",
      make: "Cessna",
      model: "172S Skyhawk",
      serialNumber: "172S-DEMO-01",
      yearManufactured: 2014,
      category: "airplane",
      aircraftClass: "single-engine land",
      airframeTotalTime: ttCurrent,
      timeSource: "hobbs",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!createdAircraft) throw new Error("failed to insert demo aircraft");
  const aircraftId = createdAircraft.id;

  await input.db.insert(aircraftInspectionSubscriptions).values([
    {
      tenantId: input.tenantId,
      aircraftId,
      programId: programByCode.get("annual")!,
      lastCompliedAt: daysAgoIso(400),
      lastCompliedAirframeTime: (airframeTT - 92).toFixed(2),
      lastCompliedCycles: 0,
    },
    {
      tenantId: input.tenantId,
      aircraftId,
      programId: programByCode.get("100_hour")!,
      lastCompliedAt: daysAgoIso(120),
      lastCompliedAirframeTime: (airframeTT - 96).toFixed(2),
      lastCompliedCycles: 0,
    },
    {
      tenantId: input.tenantId,
      aircraftId,
      programId: programByCode.get("elt")!,
      lastCompliedAt: daysAgoIso(60),
      lastCompliedAirframeTime: (airframeTT - 40).toFixed(2),
      lastCompliedCycles: 0,
    },
    {
      tenantId: input.tenantId,
      aircraftId,
      programId: programByCode.get("transponder")!,
      lastCompliedAt: daysAgoIso(90),
      lastCompliedAirframeTime: (airframeTT - 60).toFixed(2),
      lastCompliedCycles: 0,
    },
  ]);

  await input.db.insert(flightTimeEntries).values({
    tenantId: input.tenantId,
    aircraftId,
    airframeTimeNew: ttCurrent,
    airframeTimePrev: ttPrev,
    enteredByUserId: input.reporterUserId,
  });

  await input.db.insert(squawks).values({
    tenantId: input.tenantId,
    aircraftId,
    description:
      "Right main landing gear tire worn beyond service limit; cords visible. Aircraft grounded pending replacement.",
    occurredAt: daysAgoIso(2),
    reporterUserId: input.reporterUserId,
    severity: "grounding",
    status: "open",
  });

  await input.db.insert(maintenanceEntries).values({
    tenantId: input.tenantId,
    aircraftId,
    entryType: "annual_inspection",
    workPerformed:
      "Annual inspection per 14 CFR 91.409(a). Replaced #2 cylinder, serviced brakes, ELT battery and function check. Ready for return-to-service sign-off.",
    performedOn: now.toISOString().slice(0, 10),
    aircraftTotalTime: ttCurrent,
    inspectionProgramId: programByCode.get("annual")!,
  });

  return { aircraftId };
}
