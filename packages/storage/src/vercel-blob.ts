/**
 * Vercel Blob driver — the production wiring approved on PMB-9.
 *
 * The `@vercel/blob` SDK appends a random URL suffix on `put()`, so the
 * URL is not derivable from the object key alone. We persist the URL
 * on the documents row and use it for `get` / `delete`. Blob URLs stay
 * server-side: J2.1's retrieval endpoint streams bytes through the
 * backend; J2.2 (PMB-23) introduces short-lived signed URLs for the
 * direct-browser-download path.
 *
 * Construct with the `BLOB_READ_WRITE_TOKEN` env var that Vercel injects
 * on the project. Pass it in explicitly so the constructor is testable
 * and so we can re-target a different blob store in scripts.
 */

import { put, del } from "@vercel/blob";

import type { BlobStorageDriver, PutInput, PutResult } from "./driver.js";

export interface VercelBlobDriverOptions {
  token: string;
}

export class VercelBlobDriver implements BlobStorageDriver {
  private readonly token: string;

  constructor(options: VercelBlobDriverOptions) {
    this.token = options.token;
  }

  async put(input: PutInput): Promise<PutResult> {
    // Vercel Blob's SDK accepts Buffer / ArrayBuffer / File but not the
    // bare Uint8Array view. Buffer.from wraps the same underlying bytes
    // without a copy.
    const body = Buffer.from(input.body);
    const result = await put(input.key, body, {
      access: "public",
      contentType: input.contentType,
      addRandomSuffix: true,
      token: this.token,
    });
    return { url: result.url, key: input.key };
  }

  async get(target: { key: string; url: string }): Promise<Uint8Array> {
    const response = await fetch(target.url);
    if (!response.ok) {
      throw new Error(
        `vercel blob: get failed for key=${target.key} status=${response.status}`,
      );
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async delete(target: { key: string; url: string }): Promise<void> {
    await del(target.url, { token: this.token });
  }
}
