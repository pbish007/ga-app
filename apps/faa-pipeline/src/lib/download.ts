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

/** Download the FAA ReleasableAircraft ZIP and extract the five fixed-width files. */
export async function downloadFaaSnapshot(
  zipUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DownloadResult> {
  const res = await fetchImpl(zipUrl, {
    redirect: "follow",
    headers: { "user-agent": "ga-app faa-pipeline (PMB-105)" },
  });

  if (!res.ok) {
    throw new Error(
      `FAA download failed: ${res.status} ${res.statusText} for ${zipUrl}`,
    );
  }

  const zipBuf = Buffer.from(await res.arrayBuffer());
  return extractFromZip(zipBuf);
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
