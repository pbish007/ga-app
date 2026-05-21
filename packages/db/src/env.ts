/**
 * Production database environment loader.
 *
 * The runtime Postgres connection MUST come from `DATABASE_URL`. Credentials
 * never live in the repo — Vercel injects them for the deployed app and
 * `apps/web/.env.local` (gitignored) supplies them locally. See
 * `docs/runbooks/postgres-restore.md` for the full provisioning + restore
 * playbook.
 *
 * Why a fail-fast loader instead of a plain `process.env.DATABASE_URL` read:
 * a missing connection string in prod must crash loudly rather than silently
 * connecting to a default or leaking through code paths that assume a DB.
 */

export class MissingDatabaseUrlError extends Error {
  constructor() {
    super(
      "DATABASE_URL is not set. " +
        "Set it in Vercel (production) or apps/web/.env.local (development). " +
        "See docs/runbooks/postgres-restore.md for the provisioning checklist.",
    );
    this.name = "MissingDatabaseUrlError";
  }
}

/**
 * Return `DATABASE_URL` from the environment, or `undefined` if unset.
 * Use this only when an unset value is a valid runtime state (e.g. tooling
 * that may run before provisioning). Prefer {@link requireDatabaseUrl} in
 * application code that actually needs a database connection.
 */
export function getDatabaseUrl(): string | undefined {
  const value = process.env.DATABASE_URL;
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Return `DATABASE_URL` from the environment, throwing
 * {@link MissingDatabaseUrlError} if unset or empty. App code that opens
 * a real connection should call this — never read `process.env` directly.
 */
export function requireDatabaseUrl(): string {
  const value = getDatabaseUrl();
  if (value === undefined) throw new MissingDatabaseUrlError();
  return value;
}

/**
 * Best-effort assertion that the connection string forces TLS, which is the
 * project baseline (J3.1, spec §3.5). Neon's pooled and direct endpoints
 * require `sslmode=require` (or stricter) on the URL; we surface a missing
 * flag explicitly rather than silently downgrading.
 */
export function assertSslRequired(url: string): void {
  const parsed = new URL(url);
  const sslmode = parsed.searchParams.get("sslmode");
  if (sslmode === null) {
    throw new Error(
      "DATABASE_URL is missing `sslmode=require`. " +
        "Aviation records are sensitive; TLS to Postgres is non-optional. " +
        "Append `?sslmode=require` (or `&sslmode=require`) to the connection string.",
    );
  }
  if (sslmode !== "require" && sslmode !== "verify-full" && sslmode !== "verify-ca") {
    throw new Error(
      `DATABASE_URL has sslmode='${sslmode}'. ` +
        "Only require/verify-ca/verify-full are accepted.",
    );
  }
}
