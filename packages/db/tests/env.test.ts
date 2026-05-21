import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MissingDatabaseUrlError,
  assertSslRequired,
  getDatabaseUrl,
  requireDatabaseUrl,
} from "../src/env.js";

const ORIGINAL = process.env.DATABASE_URL;

describe("packages/db env loader", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = ORIGINAL;
    }
  });

  it("getDatabaseUrl returns undefined when unset or blank", () => {
    expect(getDatabaseUrl()).toBeUndefined();
    process.env.DATABASE_URL = "   ";
    expect(getDatabaseUrl()).toBeUndefined();
  });

  it("getDatabaseUrl returns the trimmed value when set", () => {
    process.env.DATABASE_URL = "  postgres://u:p@host/db?sslmode=require  ";
    expect(getDatabaseUrl()).toBe("postgres://u:p@host/db?sslmode=require");
  });

  it("requireDatabaseUrl throws MissingDatabaseUrlError when unset", () => {
    expect(() => requireDatabaseUrl()).toThrow(MissingDatabaseUrlError);
  });

  it("assertSslRequired accepts require / verify-ca / verify-full", () => {
    for (const mode of ["require", "verify-ca", "verify-full"]) {
      expect(() =>
        assertSslRequired(`postgres://u:p@host/db?sslmode=${mode}`),
      ).not.toThrow();
    }
  });

  it("assertSslRequired rejects a missing sslmode", () => {
    expect(() => assertSslRequired("postgres://u:p@host/db")).toThrow(
      /missing `sslmode=require`/,
    );
  });

  it("assertSslRequired rejects sslmode=disable / prefer / allow", () => {
    for (const mode of ["disable", "prefer", "allow"]) {
      expect(() =>
        assertSslRequired(`postgres://u:p@host/db?sslmode=${mode}`),
      ).toThrow(`sslmode='${mode}'`);
    }
  });
});
