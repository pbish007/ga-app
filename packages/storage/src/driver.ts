/**
 * Blob storage driver contract.
 *
 * Two production-facing operations (put / get) plus delete (used by the
 * tamper-evident purge path that F4 will wire up). The interface stays
 * minimal so we can swap providers (Vercel Blob → R2 → S3) without
 * changing the application layer.
 *
 * `put` returns the provider-issued URL and the canonical object key —
 * both are persisted on the documents row.
 * `get` returns the bytes as a Uint8Array. We chose bytes (not a stream)
 * for J2.1 because attachments are bounded small (<= 25 MB for MVP per
 * the upload-size guard in the route handler) and a Uint8Array round-
 * trip lets us compute a sha256 for tamper-evidence on retrieval. J2.2
 * adds a streaming `getStream()` path for large records-export bundles.
 */

export interface PutInput {
  key: string;
  body: Uint8Array;
  contentType: string;
  originalFilename: string;
}

export interface PutResult {
  url: string;
  key: string;
}

export interface BlobStorageDriver {
  put(input: PutInput): Promise<PutResult>;
  get(target: { key: string; url: string }): Promise<Uint8Array>;
  delete(target: { key: string; url: string }): Promise<void>;
}
