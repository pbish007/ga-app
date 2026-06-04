import { handleReseedDemo } from "../../../../../../lib/admin/tenants-handler";
import { getDb, getDirectDb } from "../../../../../../lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function buildDeps() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET must be set");
  const acceptUrlBase =
    process.env.INVITE_ACCEPT_URL_BASE ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "https://ga-app-taupe.vercel.app/invitations";
  return { db: getDb(), directDb: getDirectDb(), secret, acceptUrlBase };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const params = await context.params;
  return handleReseedDemo(request, buildDeps(), { id: params.id });
}
