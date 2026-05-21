/**
 * Storage environment loader. Mirrors the fail-fast posture of `@ga/db`:
 * a missing blob token in prod must crash loudly rather than silently
 * picking up a default or no-op driver.
 */

export class MissingBlobTokenError extends Error {
  constructor() {
    super(
      "BLOB_READ_WRITE_TOKEN is not set. " +
        "Vercel injects this for the deployed app; set it in apps/web/.env.local for development. " +
        "See docs/runbooks/postgres-restore.md for the provisioning checklist " +
        "(blob token lives next to the DATABASE_URL).",
    );
    this.name = "MissingBlobTokenError";
  }
}

export function getBlobToken(): string | undefined {
  const value = process.env.BLOB_READ_WRITE_TOKEN;
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function requireBlobToken(): string {
  const value = getBlobToken();
  if (value === undefined) throw new MissingBlobTokenError();
  return value;
}
