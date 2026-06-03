export const FAA_FILES = [
  "MASTER",
  "ACFTREF",
  "ENGINE",
  "DEALER",
  "DEREG",
] as const;

export type FaaFile = (typeof FAA_FILES)[number];

export const DEFAULT_FAA_ZIP_URL =
  "https://registry.faa.gov/database/ReleasableAircraft.zip";

export interface Config {
  snapshotDate: string;
  zipUrl: string;
  r2: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    endpoint: string;
  };
  databaseUrl: string;
  runId: string;
}

export function loadConfig(now: Date = new Date()): Config {
  const snapshotDate =
    process.env.SNAPSHOT_DATE?.trim() || now.toISOString().slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) {
    throw new Error(
      `SNAPSHOT_DATE must be YYYY-MM-DD, got: ${snapshotDate}`,
    );
  }

  const accountId = required("R2_ACCOUNT_ID");
  const r2 = {
    accountId,
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
    bucket: process.env.R2_BUCKET?.trim() || "faa-registry",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  };

  return {
    snapshotDate,
    zipUrl: process.env.FAA_ZIP_URL?.trim() || DEFAULT_FAA_ZIP_URL,
    r2,
    databaseUrl: required("FAA_DATABASE_URL"),
    runId: process.env.GITHUB_RUN_ID?.trim() || `local-${Date.now()}`,
  };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v.trim();
}

export function rawPrefix(snapshotDate: string): string {
  return `raw/${snapshotDate}`;
}

export function rawKey(snapshotDate: string, file: FaaFile): string {
  return `${rawPrefix(snapshotDate)}/${file}.txt`;
}
