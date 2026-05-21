import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { schema } from "@ga/db";
import { passwordHasher, type AccountsDb } from "@ga/accounts";

import {
  buildSetCookieHeader,
  createSessionCookieValue,
} from "./session";

const { users } = schema;

export interface LoginDeps {
  db: AccountsDb;
  secret: string;
  /** Override the issued-at clock in tests. */
  now?: () => Date;
}

/**
 * Thin POST handler for `/api/auth/login`. Validates `{email, password}`
 * with the A1.1 `passwordHasher`; on success, sets a signed session
 * cookie. Returns the same 401 on missing user, missing hash, and bad
 * password so the response shape does not leak whether the email
 * exists.
 */
export async function handleLogin(
  req: Request,
  deps: LoginDeps,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "expected JSON body" },
      { status: 400 },
    );
  }
  const email =
    typeof (body as { email?: unknown })?.email === "string"
      ? (body as { email: string }).email.trim().toLowerCase()
      : "";
  const password =
    typeof (body as { password?: unknown })?.password === "string"
      ? (body as { password: string }).password
      : "";
  if (!email || !password) {
    return NextResponse.json(
      { error: "email and password are required" },
      { status: 400 },
    );
  }

  const [user] = await deps.db
    .select({
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user || !user.passwordHash) {
    return NextResponse.json(
      { error: "invalid credentials" },
      { status: 401 },
    );
  }
  const ok = await passwordHasher.verify(password, user.passwordHash);
  if (!ok) {
    return NextResponse.json(
      { error: "invalid credentials" },
      { status: 401 },
    );
  }

  const now = deps.now ? deps.now() : new Date();
  const iat = Math.floor(now.getTime() / 1000);
  const cookie = createSessionCookieValue(
    { userId: user.id, iat },
    deps.secret,
  );
  const res = NextResponse.json({
    user: { id: user.id, email: user.email },
  });
  res.headers.append("Set-Cookie", buildSetCookieHeader(cookie));
  return res;
}
