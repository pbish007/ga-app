import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * App-level HMAC-signed download tokens (J2.2 / PMB-23).
 *
 * Vercel Blob stores blobs publicly; provider-level short-lived URLs are
 * not part of the free-tier SDK. We sign our own tokens so the backend
 * remains the gate: a signed URL is a short-lived credential issued by
 * the app that the download endpoint validates before proxying the bytes.
 *
 *   Client
 *     ─── GET /api/attachments/{id}/signed-url?tenant_id=... ──▶
 *                                                          [mint]
 *     ◀── { signed_url, expires_at } ──────────────────────────
 *
 *     ─── GET (signed_url) ─────────────────────────────────────▶
 *                                                        [redeem]
 *     ◀── bytes or 302 → blob URL ──────────────────────────────
 *
 * The signing secret is derived from BLOB_READ_WRITE_TOKEN so we need no
 * additional env var. Callers pass the secret explicitly so the functions
 * are testable without touching process.env.
 */

export const SIGNED_URL_DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class SignedUrlExpiredError extends Error {
  constructor(public readonly expiredAt: Date) {
    super(`signed download URL expired at ${expiredAt.toISOString()}`);
    this.name = "SignedUrlExpiredError";
  }
}

export class SignedUrlInvalidError extends Error {
  constructor(reason: string) {
    super(`signed download URL is invalid: ${reason}`);
    this.name = "SignedUrlInvalidError";
  }
}

export interface SignedDownloadPayload {
  documentId: string;
  tenantId: string;
}

export interface SignedDownloadToken {
  token: string;
  expiresAt: Date;
}

/**
 * Mint a short-lived signed download token.
 *
 * The token is a base64url-encoded JSON envelope `{ id, tid, exp, sig }`
 * where `sig` is HMAC-SHA256(secret, "{id}:{tid}:{exp}") in base64url.
 * All fields are in the envelope so the redeem endpoint is stateless.
 *
 * @param secret  Signing secret — use `requireBlobToken()` in production.
 * @param payload Document id + owning tenant id.
 * @param options Optional override for the default 5-minute TTL.
 */
export function createSignedDownloadToken(
  secret: string,
  payload: SignedDownloadPayload,
  options: { ttlMs?: number } = {},
): SignedDownloadToken {
  const ttlMs = options.ttlMs ?? SIGNED_URL_DEFAULT_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs);
  const exp = expiresAt.getTime();
  const data = `${payload.documentId}:${payload.tenantId}:${exp}`;
  const sig = createHmac("sha256", secret).update(data).digest("base64url");
  const envelope = JSON.stringify({
    id: payload.documentId,
    tid: payload.tenantId,
    exp,
    sig,
  });
  const token = Buffer.from(envelope, "utf8").toString("base64url");
  return { token, expiresAt };
}

/**
 * Verify a signed download token previously minted by
 * `createSignedDownloadToken`.
 *
 * @throws {SignedUrlInvalidError} if the token is malformed or the
 *   signature does not match — including any field that was tampered.
 * @throws {SignedUrlExpiredError} if the token's `exp` is in the past.
 */
export function verifySignedDownloadToken(
  secret: string,
  token: string,
): SignedDownloadPayload {
  let envelope: unknown;
  try {
    envelope = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new SignedUrlInvalidError("not valid base64url JSON");
  }

  if (
    typeof envelope !== "object" ||
    envelope === null ||
    !("id" in envelope) ||
    !("tid" in envelope) ||
    !("exp" in envelope) ||
    !("sig" in envelope)
  ) {
    throw new SignedUrlInvalidError("missing required fields");
  }

  const { id: documentId, tid: tenantId, exp, sig } = envelope as {
    id: unknown;
    tid: unknown;
    exp: unknown;
    sig: unknown;
  };

  if (
    typeof documentId !== "string" ||
    typeof tenantId !== "string" ||
    typeof exp !== "number" ||
    typeof sig !== "string" ||
    documentId.length === 0 ||
    tenantId.length === 0
  ) {
    throw new SignedUrlInvalidError("field types are invalid");
  }

  const data = `${documentId}:${tenantId}:${exp}`;
  const expected = createHmac("sha256", secret)
    .update(data)
    .digest("base64url");

  const expectedBuf = Buffer.from(expected, "utf8");
  const givenBuf = Buffer.from(sig, "utf8");
  if (
    expectedBuf.length !== givenBuf.length ||
    !timingSafeEqual(expectedBuf, givenBuf)
  ) {
    throw new SignedUrlInvalidError("signature mismatch");
  }

  if (Date.now() > exp) {
    throw new SignedUrlExpiredError(new Date(exp));
  }

  return { documentId, tenantId };
}
