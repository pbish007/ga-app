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

export type StorageMode = "r2" | "lakefs";

export interface Config {
  snapshotDate: string;
  zipUrl: string;
  storageMode: StorageMode;
  r2: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    endpoint: string;
  };
  lakefs: {
    stagingDir: string;
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

  const storageMode = parseStorageMode(process.env.STORAGE_MODE);

  // R2 creds are only required when the Node process is writing to R2
  // directly. In `lakefs` mode the workflow's `lakectl fs upload --direct`
  // step pushes bytes client→R2, so we don't need S3 creds here.
  const r2 = storageMode === "r2" ? loadR2Config() : stubR2Config();

  const lakefs = {
    stagingDir:
      process.env.LAKEFS_STAGING_DIR?.trim() ||
      `${process.env.RUNNER_TEMP ?? "/tmp"}/faa-stage`,
  };

  return {
    snapshotDate,
    zipUrl: process.env.FAA_ZIP_URL?.trim() || DEFAULT_FAA_ZIP_URL,
    storageMode,
    r2,
    lakefs,
    databaseUrl: required("FAA_DATABASE_URL"),
    runId: process.env.GITHUB_RUN_ID?.trim() || `local-${Date.now()}`,
  };
}

function parseStorageMode(raw: string | undefined): StorageMode {
  const v = raw?.trim().toLowerCase();
  if (!v || v === "r2") return "r2";
  if (v === "lakefs") return "lakefs";
  throw new Error(`STORAGE_MODE must be 'r2' or 'lakefs', got: ${raw}`);
}

function loadR2Config(): Config["r2"] {
  const accountId = required("R2_ACCOUNT_ID");
  return {
    accountId,
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
    bucket: process.env.R2_BUCKET?.trim() || "faa-registry",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  };
}

function stubR2Config(): Config["r2"] {
  return {
    accountId: "",
    accessKeyId: "",
    secretAccessKey: "",
    bucket: process.env.R2_BUCKET?.trim() || "faa-registry",
    endpoint: "",
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
