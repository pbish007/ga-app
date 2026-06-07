import { describe, expect, it } from "vitest";

import type { FaaSql } from "../lib/faa/client";
import { handleFaaLookup } from "../lib/faa-lookup-handler";

/**
 * Stub the FaaSql template tag. The lookup helper issues two queries
 * per call (aircraft row + freshness row); the stub matches them by
 * substring on the first text fragment so we don't depend on exact
 * whitespace.
 */
function stubSql(
  router: (queryText: string) => Promise<unknown[]>,
): FaaSql {
  // Cast to `unknown as FaaSql` — the postgres-js template tag carries
  // a deep type we don't need to faithfully reproduce. The handler
  // only calls `sql\`…\`` and awaits the result.
  return ((strings: TemplateStringsArray) =>
    router(strings.join(" "))) as unknown as FaaSql;
}

describe("handleFaaLookup", () => {
  it("returns 400 for a malformed N-number", async () => {
    const res = await handleFaaLookup(new Request("https://x"), {
      lookupDeps: { sql: stubSql(async () => []) },
      params: { nNumber: "invalid-tail-too-long" },
    });
    expect(res.status).toBe(400);
  });

  it("returns kind=match with freshness for a hit", async () => {
    const sql = stubSql(async (query) => {
      if (query.includes("snapshot_manifest")) {
        return [
          {
            snapshot_date: "2026-06-01",
            pg_loaded_at: "2026-06-01T03:00:00Z",
          },
        ];
      }
      if (query.includes("aircraft_registry_current")) {
        return [
          {
            n_number: "12345",
            make: "Cessna",
            model: "172S",
            serial_number: "17270001",
            year_mfr: 1999,
            engine_make: "Lycoming",
            engine_model: "IO-360",
            owner_name: "ACME LLC",
            expiration_date: "2027-04-01",
            airworthiness_date: "1999-05-12",
            cert_issue_date: "1999-04-30",
            status_code: "V",
          },
        ];
      }
      return [];
    });

    const res = await handleFaaLookup(new Request("https://x"), {
      lookupDeps: { sql },
      params: { nNumber: "N12345" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("match");
    expect(body.value.n_number).toBe("12345");
    expect(body.value.make).toBe("Cessna");
    expect(body.value.engine_make).toBe("Lycoming");
    expect(body.freshness.pg_loaded_at).toBe("2026-06-01T03:00:00Z");
  });

  it("returns kind=no_match with the normalized N-number when registry is empty", async () => {
    const sql = stubSql(async (query) => {
      if (query.includes("snapshot_manifest")) {
        return [
          { snapshot_date: "2026-06-01", pg_loaded_at: "2026-06-01T03:00:00Z" },
        ];
      }
      return [];
    });

    const res = await handleFaaLookup(new Request("https://x"), {
      lookupDeps: { sql },
      params: { nNumber: "n98765" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("no_match");
    expect(body.n_number).toBe("98765");
    expect(body.freshness.pg_loaded_at).toBe("2026-06-01T03:00:00Z");
  });

  it("returns 503 + lookup_unavailable when the FAA query throws", async () => {
    const sql = stubSql(async () => {
      throw new Error("FAA pool exhausted");
    });
    const res = await handleFaaLookup(new Request("https://x"), {
      lookupDeps: { sql },
      params: { nNumber: "N12345" },
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.kind).toBe("lookup_unavailable");
    expect(body.error_kind).toBe("server_error");
    expect(body.n_number).toBe("12345");
  });
});
