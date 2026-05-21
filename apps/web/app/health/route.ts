import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "web",
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
    timestamp: new Date().toISOString(),
  });
}
