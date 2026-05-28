import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";
import postgres from "postgres";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * One-shot operational endpoint to apply pending SQL migrations against the
 * production Postgres. The canonical path is the `DB migrate (production)`
 * GitHub Actions workflow (migrate.sh), but that needs DATABASE_URL_DIRECT as
 * a GitHub secret. This endpoint applies the same migrations from inside the
 * Vercel runtime — the one place the write-only DATABASE_URL_DIRECT secret is
 * available — so production can be fixed without exfiltrating the connection
 * string.
 *
 * Idempotent: tracks applied filenames in `schema_migrations`, identical to
 * migrate.sh. Re-runs skip already-applied migrations.
 *
 * Guarded by ADMIN_BOOTSTRAP_TOKEN (constant-time compare). Responds 404 when
 * the token is unset or mismatched so the endpoint is invisible without the
 * secret. Tracked for removal once PMB-64 is signed off.
 */

interface Migration {
  filename: string;
  sql: string;
}

// The two migrations missing from production (PMB-64). 0015 creates the
// aircraft_regime_changes table whose absence 500s the aircraft detail page;
// 0016 grants the tenant_app role membership + regime-catalog SELECTs. Both
// are idempotent here: 0015's table does not yet exist, and 0016 is all
// GRANT/ON CONFLICT statements that are safe to re-run.
const MIGRATIONS: Migration[] = [
  {
    filename: "0015_create_aircraft_regime_changes.sql",
    sql: `
CREATE TABLE aircraft_regime_changes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  aircraft_id       uuid NOT NULL REFERENCES aircraft(id) ON DELETE CASCADE,
  from_regime_id    uuid NOT NULL REFERENCES regimes(id) ON DELETE RESTRICT,
  to_regime_id      uuid NOT NULL REFERENCES regimes(id) ON DELETE RESTRICT,
  actor_user_id     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason            text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aircraft_regime_changes_distinct_regimes
    CHECK (from_regime_id <> to_regime_id),
  CONSTRAINT aircraft_regime_changes_reason_nonempty
    CHECK (length(trim(reason)) > 0)
);

CREATE INDEX aircraft_regime_changes_tenant_idx
  ON aircraft_regime_changes (tenant_id);
CREATE INDEX aircraft_regime_changes_aircraft_idx
  ON aircraft_regime_changes (aircraft_id, created_at DESC);

CREATE OR REPLACE FUNCTION aircraft_regime_changes_block_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'aircraft_regime_changes is append-only; row % cannot be modified', OLD.id
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER aircraft_regime_changes_block_update
BEFORE UPDATE ON aircraft_regime_changes
FOR EACH ROW
EXECUTE FUNCTION aircraft_regime_changes_block_update();

ALTER TABLE aircraft_regime_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE aircraft_regime_changes FORCE ROW LEVEL SECURITY;

CREATE POLICY app_isolation ON aircraft_regime_changes
  USING      (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));

GRANT SELECT, INSERT ON aircraft_regime_changes TO tenant_app;

INSERT INTO regime_retention_rules
  (regime_id, record_kind, retention_period_kind, retention_period_value, description)
SELECT id, 'regime_change', 'lifetime', NULL,
       '14 CFR 91.417(b)(2) principle: records establishing the regulatory regime of the aircraft are retained for the life of the aircraft.'
  FROM regimes WHERE code = 'FAA'
ON CONFLICT (regime_id, record_kind) DO NOTHING;

INSERT INTO app_permissions (code, description) VALUES
  ('aircraft.change_regime',
   'Change the regulatory regime of an aircraft. High-blast-radius write — admin only.')
ON CONFLICT (code) DO NOTHING;

INSERT INTO app_role_permissions (role_code, permission_code) VALUES
  ('admin', 'aircraft.change_regime')
ON CONFLICT (role_code, permission_code) DO NOTHING;
`,
  },
  {
    filename: "0016_grant_tenant_app_membership.sql",
    sql: `
GRANT tenant_app TO current_user;

GRANT SELECT ON regimes                              TO tenant_app;
GRANT SELECT ON regime_inspection_program_templates  TO tenant_app;
GRANT SELECT ON regime_inspection_program_intervals  TO tenant_app;
GRANT SELECT ON regime_credential_types              TO tenant_app;
GRANT SELECT ON regime_rts_templates                 TO tenant_app;
GRANT SELECT ON regime_directive_sources             TO tenant_app;
GRANT SELECT ON regime_retention_rules               TO tenant_app;

GRANT SELECT (id) ON users TO tenant_app;
`,
  },
];

function tokenOk(req: Request): boolean {
  const expected = process.env.ADMIN_BOOTSTRAP_TOKEN;
  if (!expected) return false;
  const provided = req.headers.get("x-admin-token") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<Response> {
  if (!tokenOk(request)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // DDL must run on the direct (non-pooled) endpoint — pooled connections
  // multiplex sessions and break stable-connection DDL. Fall back to the
  // pooled URL only if the direct one is absent.
  const databaseUrl =
    process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
  if (!databaseUrl) {
    return NextResponse.json(
      { error: "DATABASE_URL_DIRECT not configured" },
      { status: 500 },
    );
  }

  const sql = postgres(databaseUrl, { prepare: false });
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    for (const migration of MIGRATIONS) {
      const existing = await sql<{ filename: string }[]>`
        SELECT filename FROM schema_migrations WHERE filename = ${migration.filename}`;
      if (existing.length > 0) {
        skipped.push(migration.filename);
        continue;
      }
      await sql.begin(async (tx) => {
        await tx.unsafe(migration.sql);
        await tx`INSERT INTO schema_migrations (filename) VALUES (${migration.filename})`;
      });
      applied.push(migration.filename);
    }

    const [regimeChanges] = await sql<{ exists: boolean }[]>`
      SELECT to_regclass('public.aircraft_regime_changes') IS NOT NULL AS exists`;

    return NextResponse.json({
      ok: true,
      applied,
      skipped,
      aircraftRegimeChangesExists: regimeChanges?.exists ?? false,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        applied,
        skipped,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}
