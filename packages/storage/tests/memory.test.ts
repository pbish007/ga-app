import { describe, expect, it } from "vitest";

import { MemoryBlobDriver } from "../src/memory.js";

const TENANT = "00000000-0000-0000-0000-0000000000a1";

describe("MemoryBlobDriver", () => {
  it("round-trips bytes by (key, url)", async () => {
    const driver = new MemoryBlobDriver();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const put = await driver.put({
      key: `tenants/${TENANT}/maintenance_log/00000000-0000-0000-0000-000000000001/x.bin`,
      body: bytes,
      contentType: "application/octet-stream",
      originalFilename: "x.bin",
    });

    expect(put.url).toMatch(/^memory:\/\/tenants\//);
    const round = await driver.get({ key: put.key, url: put.url });
    expect(Array.from(round)).toEqual([1, 2, 3, 4]);
  });

  it("throws on a key it has not stored", async () => {
    const driver = new MemoryBlobDriver();
    await expect(
      driver.get({ key: "missing", url: "memory://missing" }),
    ).rejects.toThrow(/no object at key=missing/);
  });

  it("throws on url mismatch (cross-key tampering)", async () => {
    const driver = new MemoryBlobDriver();
    await driver.put({
      key: "k1",
      body: new Uint8Array([1]),
      contentType: "x",
      originalFilename: "x",
    });
    await expect(
      driver.get({ key: "k1", url: "memory://other" }),
    ).rejects.toThrow(/url mismatch/);
  });

  it("delete is idempotent on a missing key", async () => {
    const driver = new MemoryBlobDriver();
    await expect(
      driver.delete({ key: "missing", url: "memory://missing" }),
    ).resolves.toBeUndefined();
  });
});
