import { describe, it, expect } from "vitest";
import { countRecords } from "../src/lib/parse.js";

describe("countRecords", () => {
  it("returns 0 for an empty buffer", () => {
    expect(countRecords(Buffer.from(""))).toBe(0);
  });

  it("returns 0 for header-only file (LF)", () => {
    expect(countRecords(Buffer.from("N-NUMBER,SERIAL,NAME\n"))).toBe(0);
  });

  it("returns 0 for header-only file (CRLF)", () => {
    expect(countRecords(Buffer.from("N-NUMBER,SERIAL,NAME\r\n"))).toBe(0);
  });

  it("counts data lines, excluding the header (CRLF)", () => {
    const data = "H1,H2\r\nA,1\r\nB,2\r\nC,3\r\n";
    expect(countRecords(Buffer.from(data))).toBe(3);
  });

  it("counts data lines, excluding the header (LF)", () => {
    const data = "H1,H2\nA,1\nB,2\nC,3\n";
    expect(countRecords(Buffer.from(data))).toBe(3);
  });

  it("handles missing trailing newline", () => {
    const data = "H1,H2\nA,1\nB,2";
    expect(countRecords(Buffer.from(data))).toBe(2);
  });

  it("ignores trailing blank lines (FAA files commonly have one)", () => {
    const data = "H1,H2\r\nA,1\r\nB,2\r\n\r\n";
    expect(countRecords(Buffer.from(data))).toBe(2);
  });

  it("treats CR-only segments as part of the line (no double-count)", () => {
    const data = "H,X\r\nrow\r\n";
    expect(countRecords(Buffer.from(data))).toBe(1);
  });
});
