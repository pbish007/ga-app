import { describe, expect, it } from "vitest";

import {
  InvalidObjectKeyInputError,
  buildObjectKey,
  filenameToSlug,
  isTenantScopedKey,
} from "../src/object-key.js";

const TENANT = "00000000-0000-0000-0000-0000000000a1";
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000b2";
const DOC = "11111111-2222-3333-4444-555555555555";

describe("buildObjectKey (J2.1 tenant-scoped key convention)", () => {
  it("produces the tenants/{tenant}/{type}/{id}/{slug} shape", () => {
    expect(
      buildObjectKey({
        tenantId: TENANT,
        documentType: "maintenance_log",
        documentId: DOC,
        originalFilename: "Annual_Report 2026.pdf",
      }),
    ).toBe(
      `tenants/${TENANT}/maintenance_log/${DOC}/annual_report-2026.pdf`,
    );
  });

  it("rejects a non-UUID tenant id", () => {
    expect(() =>
      buildObjectKey({
        tenantId: "not-a-uuid",
        documentType: "maintenance_log",
        documentId: DOC,
        originalFilename: "x.pdf",
      }),
    ).toThrow(InvalidObjectKeyInputError);
  });

  it("rejects a non-UUID document id", () => {
    expect(() =>
      buildObjectKey({
        tenantId: TENANT,
        documentType: "maintenance_log",
        documentId: "01234",
        originalFilename: "x.pdf",
      }),
    ).toThrow(InvalidObjectKeyInputError);
  });

  it.each([
    "MAINTENANCE_LOG",
    "annual inspection",
    "annual-inspection",
    "_leading_underscore",
    "",
  ])("rejects document_type=%j", (badType) => {
    expect(() =>
      buildObjectKey({
        tenantId: TENANT,
        documentType: badType,
        documentId: DOC,
        originalFilename: "x.pdf",
      }),
    ).toThrow(InvalidObjectKeyInputError);
  });

  it("rejects a filename that slugs to empty", () => {
    expect(() =>
      buildObjectKey({
        tenantId: TENANT,
        documentType: "maintenance_log",
        documentId: DOC,
        originalFilename: "/////",
      }),
    ).toThrow(InvalidObjectKeyInputError);
  });
});

describe("isTenantScopedKey", () => {
  it("accepts a key under the matching tenant", () => {
    const key = `tenants/${TENANT}/maintenance_log/${DOC}/x.pdf`;
    expect(isTenantScopedKey(key, TENANT)).toBe(true);
  });

  it("rejects a key under a different tenant", () => {
    const key = `tenants/${TENANT}/maintenance_log/${DOC}/x.pdf`;
    expect(isTenantScopedKey(key, OTHER_TENANT)).toBe(false);
  });

  it("rejects a malformed/un-prefixed key", () => {
    expect(isTenantScopedKey(`shared/${DOC}/x.pdf`, TENANT)).toBe(false);
    expect(isTenantScopedKey(`tenants/${TENANT}`, TENANT)).toBe(false);
  });
});

describe("filenameToSlug", () => {
  it("strips path components and lowercases", () => {
    expect(filenameToSlug("/abs/path/Report.PDF")).toBe("report.pdf");
    expect(filenameToSlug("..\\windows\\Annual Inspection.pdf")).toBe(
      "annual-inspection.pdf",
    );
  });

  it("collapses whitespace and reserved characters", () => {
    expect(filenameToSlug("a  b  c.txt")).toBe("a-b-c.txt");
    expect(filenameToSlug("a?b*c.txt")).toBe("a-b-c.txt");
  });

  it("preserves a single trailing extension", () => {
    expect(filenameToSlug("archive.tar.gz")).toBe("archive.tar.gz");
  });

  it("handles a filename with no extension", () => {
    expect(filenameToSlug("README")).toBe("readme");
  });
});
