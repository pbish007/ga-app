import { NextResponse } from "next/server";

import { buildClearCookieHeader } from "../../../../lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  const res = NextResponse.json({ ok: true });
  res.headers.append("Set-Cookie", buildClearCookieHeader());
  return res;
}
