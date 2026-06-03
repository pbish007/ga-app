import { describe, it, expect, vi } from "vitest";
import { runPipeline } from "../src/ingest.js";
import { FAA_FILES, rawKey, type FaaFile } from "../src/lib/config.js";
import type { R2Client } from "../src/lib/r2.js";
import type { PipelineDb } from "../src/lib/db.js";
import type { DownloadResult } from "../src/lib/download.js";

const SNAPSHOT_DATE = "2026-06-03";

function baseConfig() {
  return {
    snapshotDate: SNAPSHOT_DATE,
    zipUrl: "https://faa.test/ReleasableAircraft.zip",
    r2: {
      accountId: "acct",
      accessKeyId: "ak",
      secretAccessKey: "sk",
      bucket: "faa-registry",
      endpoint: "https://acct.r2.cloudflarestorage.com",
    },
    databaseUrl: "postgres://test",
    runId: "test-run-1",
  };
}

function fakeDownload(): DownloadResult {
  const mk = (name: string) => ({
    file: name as FaaFile,
    buffer: Buffer.from(`H1,H2\nrow1\nrow2\n`),
    bytes: Buffer.from(`H1,H2\nrow1\nrow2\n`).length,
    sha256: `sha-${name.toLowerCase()}`,
  });
  return {
    zipBytes: 999,
    files: {
      MASTER: mk("MASTER"),
      ACFTREF: mk("ACFTREF"),
      ENGINE: mk("ENGINE"),
      DEALER: mk("DEALER"),
      DEREG: mk("DEREG"),
    },
  };
}

function makeR2Mock(initialKeys: Record<string, { etag: string; bytes: number }> = {}): {
  client: R2Client;
  store: Map<string, { etag: string; bytes: number }>;
  puts: string[];
} {
  const store = new Map(Object.entries(initialKeys));
  const puts: string[] = [];
  return {
    store,
    puts,
    client: {
      async headObject(key) {
        return store.get(key) ?? null;
      },
      async putObject(key, body) {
        const etag = `etag-${key}`;
        store.set(key, { etag, bytes: body.length });
        puts.push(key);
        return etag;
      },
    },
  };
}

function makeDbMock(initialManifest = false): {
  db: PipelineDb;
  startCalls: Array<[string, string]>;
  finishCalls: Array<[number, string, string | undefined]>;
  upserts: number;
  manifestPresent: boolean;
} {
  const startCalls: Array<[string, string]> = [];
  const finishCalls: Array<[number, string, string | undefined]> = [];
  const state = { upserts: 0, manifestPresent: initialManifest };

  const db: PipelineDb = {
    async startRun(runId, snap) {
      startCalls.push([runId, snap]);
      return 42;
    },
    async finishRun(id, status, msg) {
      finishCalls.push([id, status, msg]);
    },
    async hasManifest() {
      return state.manifestPresent;
    },
    async upsertManifest() {
      state.upserts++;
      state.manifestPresent = true;
    },
    async close() {},
  };

  return {
    db,
    startCalls,
    finishCalls,
    get upserts() {
      return state.upserts;
    },
    get manifestPresent() {
      return state.manifestPresent;
    },
  };
}

describe("runPipeline", () => {
  it("uploads all 5 files on a cold run and writes the manifest", async () => {
    const cfg = baseConfig();
    const r2 = makeR2Mock();
    const dbm = makeDbMock(false);
    const download = vi.fn(async () => fakeDownload());

    const out = await runPipeline(cfg, {
      db: dbm.db,
      r2: r2.client,
      download,
      log: () => {},
    });

    expect(out.skipped).toBe(false);
    expect(r2.puts).toHaveLength(5);
    for (const f of FAA_FILES) {
      expect(r2.puts).toContain(rawKey(SNAPSHOT_DATE, f));
    }
    expect(dbm.upserts).toBe(1);
    expect(dbm.finishCalls).toEqual([[42, "done", undefined]]);
    expect(download).toHaveBeenCalledOnce();
  });

  it("idempotent re-run: all R2 keys present + manifest row exists → no download, no PUTs, no upsert", async () => {
    const cfg = baseConfig();
    const initial: Record<string, { etag: string; bytes: number }> = {};
    for (const f of FAA_FILES) {
      initial[rawKey(SNAPSHOT_DATE, f)] = { etag: `existing-${f}`, bytes: 1 };
    }
    const r2 = makeR2Mock(initial);
    const dbm = makeDbMock(true);
    const download = vi.fn(async () => fakeDownload());

    const out = await runPipeline(cfg, {
      db: dbm.db,
      r2: r2.client,
      download,
      log: () => {},
    });

    expect(out.skipped).toBe(true);
    expect(r2.puts).toHaveLength(0);
    expect(dbm.upserts).toBe(0);
    expect(download).not.toHaveBeenCalled();
    expect(dbm.finishCalls).toEqual([[42, "done", undefined]]);
  });

  it("partial recovery: manifest row missing but some R2 keys present → only uploads missing keys, writes manifest", async () => {
    const cfg = baseConfig();
    const initial: Record<string, { etag: string; bytes: number }> = {
      [rawKey(SNAPSHOT_DATE, "MASTER")]: { etag: "existing-MASTER", bytes: 1 },
      [rawKey(SNAPSHOT_DATE, "ACFTREF")]: { etag: "existing-ACFTREF", bytes: 1 },
    };
    const r2 = makeR2Mock(initial);
    const dbm = makeDbMock(false);

    const out = await runPipeline(cfg, {
      db: dbm.db,
      r2: r2.client,
      download: async () => fakeDownload(),
      log: () => {},
    });

    expect(out.skipped).toBe(false);
    expect(r2.puts.sort()).toEqual(
      [
        rawKey(SNAPSHOT_DATE, "DEALER"),
        rawKey(SNAPSHOT_DATE, "DEREG"),
        rawKey(SNAPSHOT_DATE, "ENGINE"),
      ].sort(),
    );
    expect(dbm.upserts).toBe(1);
  });

  it("marks the run failed and rethrows when download throws", async () => {
    const cfg = baseConfig();
    const r2 = makeR2Mock();
    const dbm = makeDbMock(false);
    const download = vi.fn(async () => {
      throw new Error("boom: FAA 503");
    });

    await expect(
      runPipeline(cfg, {
        db: dbm.db,
        r2: r2.client,
        download,
        log: () => {},
      }),
    ).rejects.toThrow(/boom: FAA 503/);

    expect(dbm.finishCalls).toHaveLength(1);
    const [id, status, msg] = dbm.finishCalls[0]!;
    expect(id).toBe(42);
    expect(status).toBe("failed");
    expect(msg).toMatch(/boom: FAA 503/);
    expect(dbm.upserts).toBe(0);
  });
});
