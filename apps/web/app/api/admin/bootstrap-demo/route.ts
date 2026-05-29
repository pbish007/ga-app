import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { bootstrapAndSeed } from "../../../../lib/demo-seed";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * One-shot operational endpoint to (1) apply the tenant_app role grant
 * (migration 0016) and (2) seed the demo organization — both of which
 * require the production DATABASE_URL, which is a write-only Vercel
 * secret only available inside the runtime.
 *
 * Guarded by ADMIN_BOOTSTRAP_TOKEN (constant-time compare). Responds 404
 * when the token is unset or mismatched so the endpoint is invisible
 * without the secret. Tracked for removal once the demo is signed off.
 */
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
  // Demo seed performs cross-tenant inserts (memberships + many tenant tables)
  // and must run on the owner connection. PMB-74 repoints DATABASE_URL at the
  // non-bypass tenant_runtime, so prefer DATABASE_URL_DIRECT (still neondb_owner,
  // the migrate path) and fall back to DATABASE_URL for environments where
  // the split has not landed yet.
  const databaseUrl =
    (process.env.DATABASE_URL_DIRECT ?? "").trim() ||
    (process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) {
    return NextResponse.json(
      { error: "DATABASE_URL_DIRECT (or DATABASE_URL) not configured" },
      { status: 500 },
    );
  }
  const password = process.env.DEMO_PASSWORD || "DemoFlight!2026";
  try {
    const result = await bootstrapAndSeed(databaseUrl, password);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
