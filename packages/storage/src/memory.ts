import type { BlobStorageDriver, PutInput, PutResult } from "./driver.js";

/**
 * In-memory blob driver for tests.
 *
 * Production code never sees this — it is wired in by the route-handler
 * tests and the storage-package unit tests so we can round-trip bytes
 * without provisioning Vercel Blob in CI.
 *
 * The URL we hand back is `memory://{key}` so handlers that store the
 * URL can still look the blob up by URL on retrieval.
 */
export class MemoryBlobDriver implements BlobStorageDriver {
  private readonly store = new Map<string, { bytes: Uint8Array; url: string }>();

  async put(input: PutInput): Promise<PutResult> {
    const url = `memory://${input.key}`;
    this.store.set(input.key, { bytes: input.body, url });
    return { url, key: input.key };
  }

  async get(target: { key: string; url: string }): Promise<Uint8Array> {
    const entry = this.store.get(target.key);
    if (!entry) {
      throw new Error(`memory driver: no object at key=${target.key}`);
    }
    if (entry.url !== target.url) {
      throw new Error(
        `memory driver: url mismatch for key=${target.key}; expected=${entry.url} got=${target.url}`,
      );
    }
    return entry.bytes;
  }

  async delete(target: { key: string; url: string }): Promise<void> {
    const entry = this.store.get(target.key);
    if (!entry) return;
    if (entry.url !== target.url) {
      throw new Error(`memory driver: url mismatch on delete for key=${target.key}`);
    }
    this.store.delete(target.key);
  }

  size(): number {
    return this.store.size;
  }
}
