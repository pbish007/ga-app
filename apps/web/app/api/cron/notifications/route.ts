/**
 * Cron entry point for H1.2 + H1.3 (PMB-17).
 *
 * Schedule lives in `apps/web/vercel.json`. Every invocation:
 *
 *   1. Runs `runNotificationSweep` across every tenant. Insert-only,
 *      idempotent — re-runs are no-ops.
 *   2. Drains pending rows in email_outbox to the configured mailer.
 *
 * Auth: Vercel Cron sets `Authorization: Bearer ${CRON_SECRET}` on
 * every scheduled call. We refuse any other source. The CRON_SECRET
 * env var must be set in Vercel (Project Settings → Environment
 * Variables) before the schedule fires. Without it the route refuses
 * to run, which is the correct default in any environment.
 *
 * The route is intentionally NOT tenant-scoped: it runs as the project's
 * *system/owner* connection (`DATABASE_URL_DIRECT` → `neondb_owner`) so it
 * can read users + organization_memberships across all tenants and write
 * notifications + email_outbox without RLS gating it. PMB-74 repoints the
 * runtime `DATABASE_URL` at the non-bypass `tenant_runtime`, which CANNOT
 * cross tenants without `runAsTenantOnProductionDb` — so the cron uses
 * `getDirectDb()` (the owner connection) instead of `getDb()`. The sweep
 * itself filters by tenant_id in every query.
 */

import { NextResponse } from "next/server";

import {
  drainEmailOutbox,
  NullMailer,
  ResendMailer,
  runNotificationSweep,
  type Mailer,
  type SweepDb,
} from "@ga/notifications";

import { getDirectDb } from "../../../../lib/db";

export const dynamic = "force-dynamic";
// Compliance work — keep on Node runtime so we get the postgres-js driver
// and standard fetch.
export const runtime = "nodejs";

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${expected}`;
}

function buildMailer(): Mailer {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFICATIONS_FROM_EMAIL;
  if (!apiKey || !from) {
    return new NullMailer();
  }
  return new ResendMailer({ apiKey, from });
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDirectDb() as unknown as SweepDb;
  const sweep = await runNotificationSweep(db);
  const drain = await drainEmailOutbox(db, buildMailer());

  return NextResponse.json({
    ok: true,
    sweep,
    drain,
    timestamp: new Date().toISOString(),
  });
}
