import { createHmac, timingSafeEqual } from "node:crypto";

import { eq } from "drizzle-orm";

import { schema } from "@ga/db";
import type { AccountsDb } from "@ga/accounts";

const { users } = schema;

/**
 * Cookie name carrying the signed session payload. Read by `loadSession`
 * and set by the login handler.
 */
export const SESSION_COOKIE_NAME = "ga_session";

/**
 * 14-day session TTL. Set on the cookie via `Max-Age`; the server-side
 * `iat`/`passwordChangedAt` check is the real expiration gate.
 */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 14;

/**
 * Minimum acceptable session secret length. Short secrets defeat the
 * point of HMAC signing; we fail fast rather than silently accept a
 * weak secret in production.
 */
const MIN_SECRET_BYTES = 32;

export interface SessionPayload {
  userId: string;
  /** Seconds since epoch. Compared against `users.password_changed_at`. */
  iat: number;
}

export interface SessionUser {
  id: string;
  email: string;
  passwordChangedAt: Date | null;
}

export interface SessionRecord {
  payload: SessionPayload;
  user: SessionUser;
}

export interface SessionDeps {
  db: AccountsDb;
  /** HMAC key. Must be at least 32 bytes. */
  secret: string;
}

function assertSecretStrong(secret: string): void {
  if (Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) {
    throw new Error(
      `session secret must be at least ${MIN_SECRET_BYTES} bytes (got ${Buffer.byteLength(secret, "utf8")})`,
    );
  }
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/**
 * Encode `{userId, iat}` as `<base64url(json)>.<base64url(hmac)>`. The
 * signature covers the encoded payload, not the raw JSON, so whitespace
 * in `JSON.stringify` cannot desynchronize verification.
 */
export function createSessionCookieValue(
  payload: SessionPayload,
  secret: string,
): string {
  assertSecretStrong(secret);
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify the HMAC and parse the payload. Returns `null` on any failure
 * — caller treats that as "no session" and returns 401. Constant-time
 * compare prevents timing leaks against the secret.
 */
export function parseSessionCookieValue(
  value: string,
  secret: string,
): SessionPayload | null {
  assertSecretStrong(secret);
  const dot = value.lastIndexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = sign(body, secret);
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as SessionPayload).userId !== "string" ||
    typeof (payload as SessionPayload).iat !== "number"
  ) {
    return null;
  }
  return payload as SessionPayload;
}

/**
 * Pull `ga_session=<value>` out of the request's Cookie header without
 * pulling in a parser dependency. Returns the raw value (or null).
 */
export function readSessionCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${SESSION_COOKIE_NAME}=`)) continue;
    return trimmed.slice(SESSION_COOKIE_NAME.length + 1);
  }
  return null;
}

/**
 * Resolve the session for a request: verify the cookie HMAC, look up
 * the user, and invalidate if `password_changed_at` is newer than the
 * session's `iat`. Returns `null` whenever the session is missing or
 * invalid — the middleware turns that into a 401.
 */
export async function loadSession(
  req: Request,
  deps: SessionDeps,
): Promise<SessionRecord | null> {
  const raw = readSessionCookie(req);
  if (!raw) return null;
  const payload = parseSessionCookieValue(raw, deps.secret);
  if (!payload) return null;
  const [row] = await deps.db
    .select({
      id: users.id,
      email: users.email,
      passwordChangedAt: users.passwordChangedAt,
    })
    .from(users)
    .where(eq(users.id, payload.userId))
    .limit(1);
  if (!row) return null;
  if (
    row.passwordChangedAt &&
    Math.floor(row.passwordChangedAt.getTime() / 1000) > payload.iat
  ) {
    return null;
  }
  return { payload, user: row };
}

/**
 * Build the Set-Cookie header for a freshly issued session. `HttpOnly`
 * blocks JS access, `SameSite=Lax` blocks cross-site POSTs, and
 * `Secure` enforces HTTPS in production. Tests use the value verbatim;
 * browsers ignore `Secure` on `localhost` in dev.
 */
export function buildSetCookieHeader(cookieValue: string): string {
  return [
    `${SESSION_COOKIE_NAME}=${cookieValue}`,
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
  ].join("; ");
}

/**
 * Build the Set-Cookie header for a logout — overwrites the cookie
 * with an empty value and `Max-Age=0` so the browser discards it.
 */
export function buildClearCookieHeader(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "Max-Age=0",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
  ].join("; ");
}
