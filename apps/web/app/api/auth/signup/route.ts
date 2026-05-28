import { handleSignup } from "../../../../lib/auth/signup-handler";
import { getDb } from "../../../../lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function requireSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET must be set");
  }
  return secret;
}

export async function POST(request: Request): Promise<Response> {
  return handleSignup(request, {
    db: getDb(),
    secret: requireSessionSecret(),
  });
}
