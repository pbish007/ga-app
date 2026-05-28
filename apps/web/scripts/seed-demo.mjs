// Demo-org seed runner — the supported replacement for the retired
// POST /api/admin/bootstrap-demo endpoint (PMB-62).
//
// Reuses the single source of truth, apps/web/lib/demo-seed.ts, run via
// Node's native TypeScript support (type stripping; Node >= 24). It applies
// the (idempotent) tenant_app grants and reseeds the demo org only.
//
// Usage:
//   DATABASE_URL_DIRECT="postgres://...?sslmode=require" \
//     node apps/web/scripts/seed-demo.mjs
//
// Run from CI via the "DB seed demo (production)" workflow, or locally with a
// connection string the operator holds. Never embeds a credential.

import { bootstrapAndSeed, DEMO_ORG_NAME, DEMO_USERS } from "../lib/demo-seed.ts";

const databaseUrl =
  process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "error: set DATABASE_URL_DIRECT (or DATABASE_URL) to the Neon connection string with sslmode=require.",
  );
  process.exit(64);
}

const password = process.env.DEMO_PASSWORD || "DemoFlight!2026";

const result = await bootstrapAndSeed(databaseUrl, password);
console.log(
  JSON.stringify(
    {
      ok: true,
      org: DEMO_ORG_NAME,
      users: DEMO_USERS,
      tenantId: result.tenantId,
      tenantRoleGranted: result.tenantRoleGranted,
    },
    null,
    2,
  ),
);
