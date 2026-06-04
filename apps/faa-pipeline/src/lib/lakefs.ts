import { createHash } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { R2Client } from "./r2.js";

/**
 * Lakefs-staging "storage" client.
 *
 * In lakefs mode (PMB-144) the Node ingest does NOT push bytes to R2 directly.
 * Instead it writes each extracted FAA file to a local staging directory; a
 * downstream GitHub Actions step then runs `lakectl fs upload --pre-sign` for
 * each file, which uses a pre-signed URL so bytes flow client→R2 directly,
 * bypassing the Fly VM.
 *
 * This client implements the same {@link R2Client} interface used by the R2
 * path so the ingest core stays storage-agnostic. The returned "etag" is the
 * sha256 of the body (informational; lakeFS holds the real content address).
 *
 * `headObject` checks the staging dir for an existing file from the same run
 * — useful for restart-in-place but not for cross-run idempotency. Cross-run
 * idempotency in lakefs mode is governed by the DB manifest row (see
 * `ingest.ts`); GH Actions runners are ephemeral so cross-run staging state
 * never exists in practice.
 */
export interface LakeFsStagingClient extends R2Client {
  /** Absolute path on disk where a key would be staged. */
  pathFor(key: string): string;
  /** Root staging directory. */
  readonly stagingDir: string;
}

export function makeLakeFsStagingClient(stagingDir: string): LakeFsStagingClient {
  mkdirSync(stagingDir, { recursive: true });

  const pathFor = (key: string) => join(stagingDir, key);

  return {
    stagingDir,
    pathFor,

    async headObject(key) {
      const p = pathFor(key);
      try {
        const st = statSync(p);
        if (!st.isFile()) return null;
        return { etag: "", bytes: st.size };
      } catch (err: unknown) {
        if (isENOENT(err)) return null;
        throw err;
      }
    },

    async putObject(key, body) {
      const p = pathFor(key);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
      return sha256Hex(body);
    },
  };
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "ENOENT"
  );
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
