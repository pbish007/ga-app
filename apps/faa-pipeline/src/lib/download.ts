import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import { FAA_FILES, type FaaFile } from "./config.js";

export interface FaaFilePayload {
  file: FaaFile;
  buffer: Buffer;
  bytes: number;
  sha256: string;
}

export interface DownloadResult {
  zipBytes: number;
  files: Record<FaaFile, FaaFilePayload>;
}

export interface RetryOptions {
  /** Max attempts including the initial try. PMB-110 AC: 3. */
  maxAttempts?: number;
  /** Base delay in ms; backoff = base * 2^(attempt-1). */
  baseDelayMs?: number;
  /** Hook for tests; default is `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Hook for tests/observability; called once per attempted retry. */
  onRetry?: (info: {
    attempt: number;
    nextAttempt: number;
    delayMs: number;
    error: Error;
  }) => void;
}

const DEFAULT_RETRY: Required<Omit<RetryOptions, "onRetry">> = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Download the FAA ReleasableAircraft ZIP with bounded retry on transient
 * failures and extract the five fixed-width files.
 *
 * Retries: AC PMB-110 mandates up to 3 attempts on transient FAA download
 * failures (network error, 5xx, 429). 4xx other than 429 are permanent and
 * surface immediately so we don't waste attempts on a misconfigured URL.
 */
export async function downloadFaaSnapshot(
  zipUrl: string,
  fetchImpl: typeof fetch = fetch,
  retry: RetryOptions = {},
): Promise<DownloadResult> {
  const { maxAttempts, baseDelayMs, sleep } = { ...DEFAULT_RETRY, ...retry };
  const onRetry = retry.onRetry;

  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchImpl(zipUrl, {
        redirect: "follow",
        headers: { "user-agent": "ga-app faa-pipeline (PMB-105)" },
      });

      if (!res.ok) {
        const err = new HttpError(
          `FAA download failed: ${res.status} ${res.statusText} for ${zipUrl}`,
          res.status,
        );
        if (!isTransientStatus(res.status)) throw err;
        throw err;
      }

      const zipBuf = Buffer.from(await res.arrayBuffer());
      return extractFromZip(zipBuf);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      lastErr = e;

      const transient = isTransientError(e);
      const hasMore = attempt < maxAttempts;
      if (!transient || !hasMore) throw e;

      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      onRetry?.({ attempt, nextAttempt: attempt + 1, delayMs, error: e });
      await sleep(delayMs);
    }
  }

  throw lastErr ?? new Error("FAA download failed: unknown");
}

export class HttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "HttpError";
  }
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function isTransientError(err: Error): boolean {
  if (err instanceof HttpError) return isTransientStatus(err.status);
  // Network-level errors (ENETUNREACH, ECONNRESET, ETIMEDOUT, AbortError)
  // surface as plain Errors from undici/global fetch. Treat anything that
  // isn't a malformed-ZIP / missing-file failure as transient.
  if (/missing required files|FAA ZIP/i.test(err.message)) return false;
  return true;
}

export function extractFromZip(zipBuf: Buffer): DownloadResult {
  const zip = new AdmZip(zipBuf);
  const entries = zip.getEntries();

  const found: Partial<Record<FaaFile, FaaFilePayload>> = {};

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const base = baseName(entry.entryName).toUpperCase();
    const match = FAA_FILES.find((f) => base === `${f}.TXT`);
    if (!match) continue;

    const buf = entry.getData();
    found[match] = {
      file: match,
      buffer: buf,
      bytes: buf.length,
      sha256: sha256Hex(buf),
    };
  }

  const missing = FAA_FILES.filter((f) => !found[f]);
  if (missing.length > 0) {
    throw new Error(
      `FAA ZIP missing required files: ${missing.join(", ")}. ` +
        `Got entries: ${entries.map((e) => e.entryName).join(", ")}`,
    );
  }

  return {
    zipBytes: zipBuf.length,
    files: found as Record<FaaFile, FaaFilePayload>,
  };
}

function baseName(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx === -1 ? p : p.slice(idx + 1);
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
