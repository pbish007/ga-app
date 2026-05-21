#!/usr/bin/env node
// Verify that the runtime Postgres connection string forces TLS.
//
// Wired into:
//   * apps/web `prebuild` — every Vercel build re-verifies the live
//     DATABASE_URL before Next.js compiles. A regression to sslmode=disable
//     (or a missing sslmode) hard-fails the deploy.
//   * root `pnpm verify:tls` — same check on demand.
//   * CI (.github/workflows/ci.yml) — runs against fixture URLs so the
//     gate itself doesn't bitrot.
//
// Contract:
//   - production build + DATABASE_URL unset  -> hard fail (exit 70).
//   - DATABASE_URL set                       -> validate sslmode; also
//                                               validates DATABASE_URL_DIRECT
//                                               when present.
//   - Otherwise                              -> soft skip (exit 0).
//
// Soft-skipping outside prod keeps PR CI green when no secret is wired in,
// while still catching a regression on the production deploy path.
//
// The validation logic mirrors `packages/db/src/env.ts:assertSslRequired`.
// Duplicated here (rather than imported) so this script runs as plain
// Node ESM against a workspace whose source is still .ts.

const ACCEPTED_MODES = new Set(["require", "verify-ca", "verify-full"]);

function assertSslRequired(url, label) {
  const parsed = new URL(url);
  const sslmode = parsed.searchParams.get("sslmode");
  if (sslmode === null) {
    throw new Error(
      `${label} is missing \`sslmode=require\`. ` +
        "Aviation records are sensitive; TLS to Postgres is non-optional. " +
        "Append `?sslmode=require` (or `&sslmode=require`) to the connection string.",
    );
  }
  if (!ACCEPTED_MODES.has(sslmode)) {
    throw new Error(
      `${label} has sslmode='${sslmode}'. ` +
        "Only require/verify-ca/verify-full are accepted.",
    );
  }
}

const isProduction =
  process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
const databaseUrl = process.env.DATABASE_URL?.trim();
const databaseUrlDirect = process.env.DATABASE_URL_DIRECT?.trim();

if (!databaseUrl) {
  if (isProduction) {
    console.error(
      "check-tls: DATABASE_URL is not set in a production build. " +
        "Set it in Vercel → Project → Environment Variables → Production.",
    );
    process.exit(70);
  }
  console.log("check-tls: DATABASE_URL not set; skipping (non-production environment).");
  process.exit(0);
}

const checked = [];
try {
  assertSslRequired(databaseUrl, "DATABASE_URL");
  checked.push("DATABASE_URL");
  if (databaseUrlDirect) {
    assertSslRequired(databaseUrlDirect, "DATABASE_URL_DIRECT");
    checked.push("DATABASE_URL_DIRECT");
  }
} catch (err) {
  console.error(`check-tls: FAIL — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(71);
}

console.log(`check-tls: OK — ${checked.join(", ")} enforce TLS (sslmode=require or stricter).`);
