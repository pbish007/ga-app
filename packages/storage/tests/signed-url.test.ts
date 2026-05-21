import { describe, expect, it } from "vitest";

import {
  SIGNED_URL_DEFAULT_TTL_MS,
  SignedUrlExpiredError,
  SignedUrlInvalidError,
  createSignedDownloadToken,
  verifySignedDownloadToken,
} from "../src/signed-url.js";

const SECRET = "test-secret-not-for-production";
const DOC_ID = "00000000-0000-0000-0000-000000000001";
const TENANT_ID = "00000000-0000-0000-0000-000000000002";

describe("J2.2 signed-URL tokens (PMB-23)", () => {
  it("mints a verifiable token that round-trips cleanly", () => {
    const { token, expiresAt } = createSignedDownloadToken(SECRET, {
      documentId: DOC_ID,
      tenantId: TENANT_ID,
    });

    expect(token).toBeTruthy();
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + SIGNED_URL_DEFAULT_TTL_MS + 50,
    );

    const payload = verifySignedDownloadToken(SECRET, token);
    expect(payload.documentId).toBe(DOC_ID);
    expect(payload.tenantId).toBe(TENANT_ID);
  });

  it("respects a custom TTL", () => {
    const ttlMs = 60 * 1000;
    const { expiresAt } = createSignedDownloadToken(
      SECRET,
      { documentId: DOC_ID, tenantId: TENANT_ID },
      { ttlMs },
    );
    const diff = expiresAt.getTime() - Date.now();
    expect(diff).toBeGreaterThan(ttlMs - 100);
    expect(diff).toBeLessThanOrEqual(ttlMs + 50);
  });

  it("throws SignedUrlExpiredError for a token past its TTL", async () => {
    const { token } = createSignedDownloadToken(
      SECRET,
      { documentId: DOC_ID, tenantId: TENANT_ID },
      { ttlMs: 1 },
    );

    // Wait for the 1 ms TTL to elapse.
    await new Promise((r) => setTimeout(r, 5));

    expect(() => verifySignedDownloadToken(SECRET, token)).toThrow(
      SignedUrlExpiredError,
    );
  });

  it("throws SignedUrlInvalidError for a tampered document id", () => {
    const { token } = createSignedDownloadToken(SECRET, {
      documentId: DOC_ID,
      tenantId: TENANT_ID,
    });

    // Decode and tamper the id field, then re-encode.
    const raw = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    raw.id = "00000000-0000-0000-0000-000000000099";
    const tampered = Buffer.from(JSON.stringify(raw), "utf8").toString(
      "base64url",
    );

    expect(() => verifySignedDownloadToken(SECRET, tampered)).toThrow(
      SignedUrlInvalidError,
    );
  });

  it("throws SignedUrlInvalidError for a tampered tenant id", () => {
    const { token } = createSignedDownloadToken(SECRET, {
      documentId: DOC_ID,
      tenantId: TENANT_ID,
    });
    const raw = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    raw.tid = "00000000-0000-0000-0000-000000000099";
    const tampered = Buffer.from(JSON.stringify(raw), "utf8").toString(
      "base64url",
    );

    expect(() => verifySignedDownloadToken(SECRET, tampered)).toThrow(
      SignedUrlInvalidError,
    );
  });

  it("throws SignedUrlInvalidError for a wrong secret", () => {
    const { token } = createSignedDownloadToken(SECRET, {
      documentId: DOC_ID,
      tenantId: TENANT_ID,
    });

    expect(() =>
      verifySignedDownloadToken("wrong-secret", token),
    ).toThrow(SignedUrlInvalidError);
  });

  it("throws SignedUrlInvalidError for garbage input", () => {
    expect(() => verifySignedDownloadToken(SECRET, "not-a-token")).toThrow(
      SignedUrlInvalidError,
    );
    expect(() => verifySignedDownloadToken(SECRET, "e30=")).toThrow(
      SignedUrlInvalidError,
    );
  });
});
