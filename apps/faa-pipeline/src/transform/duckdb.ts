/**
 * Thin wrapper around the DuckDB CLI binary.
 *
 * The plan ([PMB-106 plan §"Tool choice"](/PMB/issues/PMB-106#document-plan))
 * pins DuckDB as a single static binary, shelled out from Node — not the
 * `@duckdb/node-api` npm package. CI installs the binary in a cached
 * `actions/cache` step; locally, set `DUCKDB_BINARY` or have `duckdb` on PATH.
 *
 * R2 access uses the `httpfs` extension. The bronze/gold modules build an SQL
 * preamble with `INSTALL httpfs; LOAD httpfs; SET s3_*` from injected env
 * vars; credentials are never written to a file on disk.
 */

import { spawn } from "node:child_process";
import { Readable } from "node:stream";

export interface DuckDbOptions {
  /** Path to duckdb binary. Defaults to `DUCKDB_BINARY` env var, else `duckdb`. */
  binary?: string;
}

export interface R2Credentials {
  hostname: string;          // e.g. <account>.r2.cloudflarestorage.com (no scheme)
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;           // defaults to 'auto'
}

/**
 * Builds the SQL preamble that loads httpfs and configures S3 creds for R2.
 * Inject this at the top of any DuckDB query that reads/writes `s3://` URLs.
 */
export function r2Preamble(c: R2Credentials): string {
  // Single-quote-escape: DuckDB SQL uses '' to escape '. The values here are
  // R2 credentials; reject any embedded single quote rather than trying to
  // escape it (R2 keys are base64-ish hex and never contain quotes in practice).
  const safe = (v: string, name: string) => {
    if (v.includes("'")) {
      throw new Error(`R2 credential ${name} contains a single quote; refusing to inject`);
    }
    return `'${v}'`;
  };

  return [
    "INSTALL httpfs;",
    "LOAD httpfs;",
    `SET s3_region=${safe(c.region ?? "auto", "region")};`,
    `SET s3_endpoint=${safe(c.hostname, "endpoint")};`,
    `SET s3_access_key_id=${safe(c.accessKeyId, "accessKeyId")};`,
    `SET s3_secret_access_key=${safe(c.secretAccessKey, "secretAccessKey")};`,
    "SET s3_url_style='path';",
    "SET s3_use_ssl=true;",
  ].join("\n");
}

export interface RunDuckSqlResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a multi-statement SQL script through `duckdb -batch -csv`. Returns
 * stdout (CSV with header for the final SELECT, if any) and stderr.
 *
 * Throws on non-zero exit. SQL is fed via stdin so credentials never appear
 * on the command line.
 */
export async function runDuckSql(
  sql: string,
  opts: DuckDbOptions = {},
): Promise<RunDuckSqlResult> {
  const binary = opts.binary ?? process.env.DUCKDB_BINARY ?? "duckdb";
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["-batch", "-csv"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`duckdb exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve({ stdout, stderr });
    });

    child.stdin.end(sql);
  });
}

/**
 * Spawn duckdb and stream its stdout (the result of the SQL) as a Node
 * Readable. Used by pg-load to pipe gold parquet → CSV → pg COPY without
 * materialising the whole table in memory.
 *
 * Returned promise resolves with the final exit summary; reject on non-zero
 * exit.
 */
export interface StreamDuckSqlHandle {
  stdout: Readable;
  done: Promise<{ stderr: string }>;
}

export function streamDuckSql(
  sql: string,
  opts: DuckDbOptions = {},
): StreamDuckSqlHandle {
  const binary = opts.binary ?? process.env.DUCKDB_BINARY ?? "duckdb";
  const child = spawn(binary, ["-batch", "-csv", "-noheader"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

  const done = new Promise<{ stderr: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`duckdb exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      resolve({ stderr });
    });
  });

  child.stdin.end(sql);
  return { stdout: child.stdout, done };
}

/**
 * Parse a single-row CSV result from runDuckSql into a Record of column→value.
 * Used to capture small scalar results like row counts.
 *
 * DuckDB's `-csv` mode emits a header row followed by data rows; we take the
 * first data row.
 */
export function parseSingleRowCsv(stdout: string): Record<string, string> {
  const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return {};
  const headers = parseCsvLine(lines[0]!);
  const values = parseCsvLine(lines[1]!);
  const out: Record<string, string> = {};
  for (let i = 0; i < headers.length; i++) {
    out[headers[i]!] = values[i] ?? "";
  }
  return out;
}

/** Minimal RFC-4180-ish CSV line parser; sufficient for DuckDB's CSV output. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { buf += '"'; i++; }
      else if (ch === '"') { inQuote = false; }
      else { buf += ch; }
    } else {
      if (ch === ",") { out.push(buf); buf = ""; }
      else if (ch === '"' && buf.length === 0) { inQuote = true; }
      else { buf += ch; }
    }
  }
  out.push(buf);
  return out;
}
