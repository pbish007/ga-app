#!/usr/bin/env node
// Seed (or re-seed) the deterministic demo organization used for the MVP
// board acceptance demo (PMB-61 / PMB-60).
//
// Idempotent: deletes any prior demo org (by name) + demo users (by email),
// then recreates a complete, walkable dataset:
//   * Blue Sky Aviation (Demo) — an owner/operator tenant on the FAA regime.
//   * 3 users: admin, a credentialed mechanic (A&P/IA), an uncredentialed pilot.
//   * 1 aircraft (N172DEMO) subscribed to FAA inspection programs producing
//     BOTH an overdue item (annual) and a due-soon item (100-hour).
//   * 1 open grounding squawk (aircraft not airworthy).
//   * 1 signed maintenance entry (proof) + 1 draft entry (sign it live).
//
// Tenant-scoped tables enforce RLS; we set app.current_tenant_id so the
// FORCE-RLS policies pass, mirroring the app's tenant write path.
//
// Usage:
//   SEED_DATABASE_URL="postgres://...sslmode=require" node apps/web/scripts/seed-demo.mjs
// (falls back to DATABASE_URL_DIRECT, then DATABASE_URL)

import { randomBytes, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";

import postgres from "postgres";

const scrypt = promisify(scryptCb);

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

const DEMO_ORG_NAME = "Blue Sky Aviation (Demo)";
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "DemoFlight!2026";
const USERS = {
  admin: "owner@demo.gaapp.io",
  mechanic: "mechanic@demo.gaapp.io",
  pilot: "pilot@demo.gaapp.io",
};

const DAY = 24 * 60 * 60 * 1000;
function daysAgo(n) {
  return new Date(Date.now() - n * DAY);
}
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function resolveUrl() {
  const url =
    process.env.SEED_DATABASE_URL ||
    process.env.DATABASE_URL_DIRECT ||
    process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "error: set SEED_DATABASE_URL (or DATABASE_URL_DIRECT / DATABASE_URL).",
    );
    process.exit(64);
  }
  if (!/sslmode=(require|verify-ca|verify-full)/.test(url)) {
    console.warn(
      "warning: connection string does not request TLS (sslmode=require).",
    );
  }
  return url;
}

async function main() {
  const sql = postgres(resolveUrl(), { prepare: false });
  try {
    // ---- Lookups (regime catalog is global reference data) ----
    const [regime] = await sql`
      SELECT id FROM regimes WHERE code = 'FAA' LIMIT 1`;
    if (!regime) throw new Error("FAA regime not found — run migrations first.");
    const regimeId = regime.id;

    const programRows = await sql`
      SELECT code, id FROM regime_inspection_program_templates
       WHERE regime_id = ${regimeId}`;
    const programByCode = Object.fromEntries(
      programRows.map((r) => [r.code, r.id]),
    );
    const need = ["annual", "100_hour", "elt", "transponder"];
    for (const code of need) {
      if (!programByCode[code]) {
        throw new Error(`inspection program template '${code}' not found`);
      }
    }

    const [iaType] = await sql`
      SELECT id FROM regime_credential_types
       WHERE regime_id = ${regimeId} AND code = 'ia' LIMIT 1`;
    if (!iaType) throw new Error("IA credential type not found");

    const [rts100] = await sql`
      SELECT id, body FROM regime_rts_templates
       WHERE regime_id = ${regimeId} AND code = '100_hour' LIMIT 1`;
    if (!rts100) throw new Error("100_hour RTS template not found");

    const adminHash = await hashPassword(DEMO_PASSWORD);
    const mechHash = await hashPassword(DEMO_PASSWORD);
    const pilotHash = await hashPassword(DEMO_PASSWORD);
    const now = new Date();

    await sql.begin(async (sql) => {
      // ---- Idempotency: remove prior demo data ----
      await sql`DELETE FROM organizations WHERE name = ${DEMO_ORG_NAME}`;
      await sql`
        DELETE FROM users
         WHERE lower(email) IN (${USERS.admin}, ${USERS.mechanic}, ${USERS.pilot})`;

      // ---- Users (global identity, no tenant scope) ----
      const [admin] = await sql`
        INSERT INTO users (email, password_hash, email_verified_at, password_changed_at)
        VALUES (${USERS.admin}, ${adminHash}, ${now}, ${now}) RETURNING id`;
      const [mechanic] = await sql`
        INSERT INTO users (email, password_hash, email_verified_at, password_changed_at)
        VALUES (${USERS.mechanic}, ${mechHash}, ${now}, ${now}) RETURNING id`;
      const [pilot] = await sql`
        INSERT INTO users (email, password_hash, email_verified_at, password_changed_at)
        VALUES (${USERS.pilot}, ${pilotHash}, ${now}, ${now}) RETURNING id`;

      // ---- Organization (FAA regime default — K2 seam) ----
      const [org] = await sql`
        INSERT INTO organizations (name, org_type, default_regime_id)
        VALUES (${DEMO_ORG_NAME}, 'owner', ${regimeId}) RETURNING id`;
      const tenantId = org.id;

      // Set tenant context so FORCE-RLS inserts below satisfy the policy.
      await sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

      // ---- Memberships ----
      await sql`
        INSERT INTO organization_memberships (tenant_id, user_id, role) VALUES
          (${tenantId}, ${admin.id}, 'admin'),
          (${tenantId}, ${mechanic.id}, 'mechanic'),
          (${tenantId}, ${pilot.id}, 'pilot')`;

      // ---- Mechanic credential (A&P/IA, current) — authorizes sign-off ----
      const [cred] = await sql`
        INSERT INTO user_credentials
          (user_id, regime_credential_type_id, certificate_number, issued_on, expires_on)
        VALUES (${mechanic.id}, ${iaType.id}, 'IA-DEMO-4477', '2019-06-01', '2031-06-01')
        RETURNING id`;

      // ---- Aircraft ----
      const airframeTT = 4860.5;
      const [aircraft] = await sql`
        INSERT INTO aircraft
          (tenant_id, regime_id, registration, make, model, serial_number,
           year_manufactured, category, aircraft_class, airframe_total_time, time_source)
        VALUES (${tenantId}, ${regimeId}, 'N172DEMO', 'Cessna', '172S Skyhawk',
                '172S-DEMO-01', 2014, 'airplane', 'single-engine land',
                ${airframeTT}, 'hobbs')
        RETURNING id`;
      const aircraftId = aircraft.id;

      // ---- Inspection subscriptions ----
      // annual (12 months): complied 400 days ago -> ~35 days OVERDUE.
      await sql`
        INSERT INTO aircraft_inspection_subscriptions
          (tenant_id, aircraft_id, program_id, last_complied_at,
           last_complied_airframe_time, last_complied_cycles)
        VALUES (${tenantId}, ${aircraftId}, ${programByCode["annual"]},
                ${daysAgo(400)}, ${airframeTT - 92}, 0)`;
      // 100-hour: anchored 96 h ago -> 4.0 h remaining -> DUE SOON (<10 h).
      await sql`
        INSERT INTO aircraft_inspection_subscriptions
          (tenant_id, aircraft_id, program_id, last_complied_at,
           last_complied_airframe_time, last_complied_cycles)
        VALUES (${tenantId}, ${aircraftId}, ${programByCode["100_hour"]},
                ${daysAgo(120)}, ${airframeTT - 96}, 0)`;
      // ELT (12 months): complied 60 days ago -> OK.
      await sql`
        INSERT INTO aircraft_inspection_subscriptions
          (tenant_id, aircraft_id, program_id, last_complied_at,
           last_complied_airframe_time, last_complied_cycles)
        VALUES (${tenantId}, ${aircraftId}, ${programByCode["elt"]},
                ${daysAgo(60)}, ${airframeTT - 40}, 0)`;
      // Transponder (24 months): complied 90 days ago -> OK.
      await sql`
        INSERT INTO aircraft_inspection_subscriptions
          (tenant_id, aircraft_id, program_id, last_complied_at,
           last_complied_airframe_time, last_complied_cycles)
        VALUES (${tenantId}, ${aircraftId}, ${programByCode["transponder"]},
                ${daysAgo(90)}, ${airframeTT - 60}, 0)`;

      // ---- Flight-time entry (running total advanced to current) ----
      await sql`
        INSERT INTO flight_time_entries
          (tenant_id, aircraft_id, airframe_time_new, airframe_time_prev, entered_by_user_id)
        VALUES (${tenantId}, ${aircraftId}, ${airframeTT}, ${airframeTT - 1.5}, ${pilot.id})`;

      // ---- Open grounding squawk (aircraft not airworthy) ----
      await sql`
        INSERT INTO squawks
          (tenant_id, aircraft_id, description, occurred_at, reporter_user_id, severity, status)
        VALUES (${tenantId}, ${aircraftId},
                'Right main landing gear tire worn beyond service limit; cords visible. Aircraft grounded pending replacement.',
                ${daysAgo(2)}, ${pilot.id}, 'grounding', 'open')`;

      // ---- Signed maintenance entry (immutable proof / return-to-service) ----
      const signedOn = daysAgo(10);
      await sql`
        INSERT INTO maintenance_entries
          (tenant_id, aircraft_id, entry_type, work_performed, performed_on,
           aircraft_total_time, inspection_program_id, signed_at, signed_by_user_id,
           signed_by_credential_id, signed_by_certificate_number, rts_template_id, rts_rendered_body)
        VALUES (${tenantId}, ${aircraftId}, '100_hour_inspection',
                'Completed 100-hour inspection per 14 CFR 91.409(b). Oil and filter change, compression check all cylinders within limits, control rigging verified.',
                ${isoDate(signedOn)}, ${airframeTT - 100}, ${programByCode["100_hour"]},
                ${signedOn}, ${mechanic.id}, ${cred.id}, 'IA-DEMO-4477',
                ${rts100.id}, ${rts100.body})`;

      // ---- Draft maintenance entry (sign live during the demo) ----
      await sql`
        INSERT INTO maintenance_entries
          (tenant_id, aircraft_id, entry_type, work_performed, performed_on,
           aircraft_total_time, inspection_program_id)
        VALUES (${tenantId}, ${aircraftId}, 'annual_inspection',
                'Annual inspection per 14 CFR 91.409(a). Replaced #2 cylinder, serviced brakes, ELT battery and function check. Ready for return-to-service sign-off.',
                ${isoDate(now)}, ${airframeTT}, ${programByCode["annual"]})`;

      console.log(`Seeded demo org ${tenantId} (${DEMO_ORG_NAME}).`);
    });

    console.log("");
    console.log("Demo credentials (password for all):", DEMO_PASSWORD);
    console.log("  admin    ->", USERS.admin, "(manage org, aircraft, squawks)");
    console.log("  mechanic ->", USERS.mechanic, "(A&P/IA — sign-off ALLOWED)");
    console.log("  pilot    ->", USERS.pilot, "(no credential — sign-off BLOCKED)");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exit(1);
});
