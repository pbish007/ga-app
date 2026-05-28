import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";
import postgres from "postgres";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * One-shot operational endpoint to apply pending SQL migrations against the
 * production Postgres from inside the Vercel runtime — the one place the
 * write-only DATABASE_URL_DIRECT secret is available, and where the connection
 * authenticates as the privileged owner role (neondb_owner).
 *
 * PMB-70 use: the `DB migrate (production)` GitHub Actions workflow connects as
 * the low-privilege `authenticator` role and fails with `permission denied for
 * schema public`. This endpoint applies migration 0017 (which grants the CI
 * role the privileges it needs) as the owner, then the GH workflow path works.
 *
 * It also reconciles the schema_migrations ledger: migrations 0001-0016 are
 * already applied to prod (the app runs end to end) but the PMB-64 endpoint
 * only ever recorded 0015 + 0016, so older filenames may be absent from the
 * ledger. migrate.sh would then try to re-apply them (non-idempotent CREATE
 * TABLEs) and fail. Recording them (ON CONFLICT DO NOTHING) makes the
 * subsequent migrate.sh run a deterministic no-op.
 *
 * Idempotent. Guarded by ADMIN_BOOTSTRAP_TOKEN (constant-time compare);
 * responds 404 when the token is unset or mismatched so the endpoint is
 * invisible without the secret. Tracked for removal once PMB-70 is verified.
 */

interface Migration {
  filename: string;
  sql: string;
}

// Filenames known to be already applied to production. Recorded defensively so
// the GH migrate.sh path skips them instead of re-running their (non-idempotent)
// CREATE TABLE statements. Keep in sync with packages/db/migrations/.
const ALREADY_APPLIED: string[] = [
  "0001_create_regimes.sql",
  "0002_create_accounts.sql",
  "0003_create_documents.sql",
  "0004_enable_tenant_rls.sql",
  "0005_create_roles.sql",
  "0006_user_credentials.sql",
  "0007_create_aircraft.sql",
  "0008_create_components.sql",
  "0009_create_flight_time_entries.sql",
  "0010_create_inspection_program_intervals.sql",
  "0011_create_aircraft_inspection_subscriptions.sql",
  "0012_create_squawks.sql",
  "0013_create_maintenance_entries.sql",
  "0014_create_notifications.sql",
  "0015_create_aircraft_regime_changes.sql",
  "0016_grant_tenant_app_membership.sql",
];

// Migrations to apply through this endpoint. Mirror packages/db/migrations/
// exactly. 0017 grants the CI `authenticator` role its migrate privileges.
const MIGRATIONS: Migration[] = [
  {
    filename: "0017_grant_migrate_role.sql",
    sql: `
GRANT USAGE, CREATE ON SCHEMA public TO authenticator;

GRANT SELECT, INSERT ON schema_migrations TO authenticator;
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

type Sql = ReturnType<typeof postgres>;

async function ledger(sql: Sql): Promise<string[]> {
  const rows = await sql<{ filename: string }[]>`
    SELECT filename FROM schema_migrations ORDER BY filename`;
  return rows.map((r) => r.filename);
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
  const backfilled: string[] = [];
  try {
    const connectedAs = await sql<{ current_user: string }[]>`
      SELECT current_user`;

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const ledgerBefore = await ledger(sql);

    // Reconcile the ledger with reality (idempotent).
    for (const filename of ALREADY_APPLIED) {
      const ins = await sql`
        INSERT INTO schema_migrations (filename) VALUES (${filename})
        ON CONFLICT (filename) DO NOTHING
        RETURNING filename`;
      if (ins.length > 0) backfilled.push(filename);
    }

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

    const ledgerAfter = await ledger(sql);

    return NextResponse.json({
      ok: true,
      connectedAs: connectedAs[0]?.current_user ?? null,
      ledgerBefore,
      backfilled,
      applied,
      skipped,
      ledgerAfter,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        applied,
        skipped,
        backfilled,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}
