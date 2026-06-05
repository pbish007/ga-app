import { describe, expect, it } from "vitest";

import {
  badgeLabel,
  daysUntilExpiry,
  getCredentialState,
  worstState,
} from "../lib/credential-state";

const NOW = new Date("2026-06-05T12:00:00Z");

describe("getCredentialState", () => {
  it("returns 'current' when expiresOn is null and revokedAt is null", () => {
    expect(
      getCredentialState({ expiresOn: null, revokedAt: null }, NOW),
    ).toBe("current");
  });

  it("returns 'revoked' when revokedAt is set, regardless of expiresOn", () => {
    expect(
      getCredentialState(
        {
          expiresOn: "2099-01-01",
          revokedAt: "2026-01-01T00:00:00Z",
        },
        NOW,
      ),
    ).toBe("revoked");
  });

  it("returns 'expired' when expiresOn is today or in the past", () => {
    expect(
      getCredentialState({ expiresOn: "2026-06-05", revokedAt: null }, NOW),
    ).toBe("expired");
    expect(
      getCredentialState({ expiresOn: "2026-06-04", revokedAt: null }, NOW),
    ).toBe("expired");
  });

  it("returns 'expiring' for expiry within 60 days", () => {
    expect(
      getCredentialState({ expiresOn: "2026-08-04", revokedAt: null }, NOW),
    ).toBe("expiring");
    expect(
      getCredentialState({ expiresOn: "2026-06-06", revokedAt: null }, NOW),
    ).toBe("expiring");
  });

  it("returns 'current' for expiry beyond 60 days", () => {
    expect(
      getCredentialState({ expiresOn: "2026-08-05", revokedAt: null }, NOW),
    ).toBe("current");
    expect(
      getCredentialState({ expiresOn: "2027-12-31", revokedAt: null }, NOW),
    ).toBe("current");
  });
});

describe("daysUntilExpiry", () => {
  it("returns null when expiresOn is null", () => {
    expect(daysUntilExpiry(null, NOW)).toBe(null);
  });

  it("returns negative when expired", () => {
    expect(daysUntilExpiry("2026-06-01", NOW)).toBe(-4);
  });

  it("returns positive day count when in future", () => {
    expect(daysUntilExpiry("2026-06-15", NOW)).toBe(10);
  });
});

describe("badgeLabel", () => {
  it("includes day count for expiring", () => {
    expect(badgeLabel("expiring", 30)).toBe("Expiring soon (30 days)");
  });
  it("falls back to plain label for expiring with no day count", () => {
    expect(badgeLabel("expiring", null)).toBe("Expiring soon");
  });
  it("uses 'No certs' for none state", () => {
    expect(badgeLabel("none", null)).toBe("No certs");
  });
});

describe("worstState", () => {
  it("returns 'none' for empty list", () => {
    expect(worstState([], NOW)).toBe("none");
  });

  it("prefers expired over expiring over current", () => {
    expect(
      worstState(
        [
          { expiresOn: null, revokedAt: null },
          { expiresOn: "2026-06-10", revokedAt: null },
          { expiresOn: "2026-05-01", revokedAt: null },
        ],
        NOW,
      ),
    ).toBe("expired");
  });

  it("returns 'expiring' when most worrying is within the warning window", () => {
    expect(
      worstState(
        [
          { expiresOn: null, revokedAt: null },
          { expiresOn: "2026-06-20", revokedAt: null },
        ],
        NOW,
      ),
    ).toBe("expiring");
  });
});
