import { describe, expect, it } from "vitest";

import type { FaaSql } from "../lib/faa/client";
import { handleFaaSearch } from "../lib/faa-search-handler";

interface CapturedQuery {
  text: string;
  values: unknown[];
}

/**
 * Stub the FaaSql template tag. The search helper issues two queries
 * (freshness + aircraft prefix scan); the router matches by substring
 * on the joined template text. When `captured` is provided we record
 * the joined SQL text and bound parameter values so AC5 can assert
 * parameter binding for `q`.
 */
function stubSql(
  router: (queryText: string) => Promise<unknown[]>,
  captured?: CapturedQuery[],
): FaaSql {
  return ((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join(" ");
    captured?.push({ text, values });
    return router(text);
  }) as unknown as FaaSql;
}

function searchRequest(query: string): Request {
  return new Request(`https://x/api/orgs/t/faa/aircraft/search?${query}`);
}

const FRESHNESS_ROW = {
  snapshot_date: "2026-06-01",
  pg_loaded_at: "2026-06-01T03:00:00Z",
};

const ROW_12345 = {
  n_number: "12345",
  make: "CESSNA",
  model: "172N",
  owner_name: "JOHN DOE",
  year_mfr: 1978,
};

const ROW_12346 = {
  n_number: "12346",
  make: "PIPER",
  model: "PA-28",
  owner_name: "ACME LLC",
  year_mfr: 1985,
};

describe("handleFaaSearch", () => {
  it("AC1: returns kind=results with matches and freshness", async () => {
    const sql = stubSql(async (q) => {
      if (q.includes("snapshot_manifest")) return [FRESHNESS_ROW];
      if (q.includes("aircraft_registry_current")) return [ROW_12345, ROW_12346];
      return [];
    });
    const res = await handleFaaSearch(searchRequest("q=N123"), {
      lookupDeps: { sql },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("results");
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toEqual({
      n_number: "12345",
      make: "CESSNA",
      model: "172N",
      owner_name: "JOHN DOE",
      year_mfr: 1978,
    });
    expect(body.freshness.pg_loaded_at).toBe("2026-06-01T03:00:00Z");
  });

  it("AC1: empty make/model coalesce to null in shaped row", async () => {
    const sql = stubSql(async (q) => {
      if (q.includes("snapshot_manifest")) return [FRESHNESS_ROW];
      if (q.includes("aircraft_registry_current")) {
        return [
          {
            n_number: "99999",
            make: "",
            model: "",
            owner_name: null,
            year_mfr: null,
          },
        ];
      }
      return [];
    });
    const res = await handleFaaSearch(searchRequest("q=N9"), {
      lookupDeps: { sql },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0]).toEqual({
      n_number: "99999",
      make: null,
      model: null,
      owner_name: null,
      year_mfr: null,
    });
  });

  it("AC2: returns 400 for missing q", async () => {
    const res = await handleFaaSearch(searchRequest(""), {
      lookupDeps: { sql: stubSql(async () => []) },
    });
    expect(res.status).toBe(400);
  });

  it("AC2: returns 400 for q=N (normalizes to empty)", async () => {
    const res = await handleFaaSearch(searchRequest("q=N"), {
      lookupDeps: { sql: stubSql(async () => []) },
    });
    expect(res.status).toBe(400);
  });

  it("AC2: returns 400 for q=N123456 (>5 chars after normalize)", async () => {
    const res = await handleFaaSearch(searchRequest("q=N123456"), {
      lookupDeps: { sql: stubSql(async () => []) },
    });
    expect(res.status).toBe(400);
  });

  it("AC2: returns 400 for q containing a wildcard", async () => {
    const res = await handleFaaSearch(searchRequest("q=N1%25"), {
      lookupDeps: { sql: stubSql(async () => []) },
    });
    expect(res.status).toBe(400);
  });

  it("AC2: accepts 1-char prefix after normalization", async () => {
    const sql = stubSql(async (q) => {
      if (q.includes("snapshot_manifest")) return [FRESHNESS_ROW];
      return [];
    });
    const res = await handleFaaSearch(searchRequest("q=N1"), {
      lookupDeps: { sql },
    });
    expect(res.status).toBe(200);
  });

  it("AC3: clamps limit=999 to 25", async () => {
    const captured: CapturedQuery[] = [];
    const sql = stubSql(
      async (q) => {
        if (q.includes("snapshot_manifest")) return [FRESHNESS_ROW];
        return [];
      },
      captured,
    );
    const res = await handleFaaSearch(searchRequest("q=N1&limit=999"), {
      lookupDeps: { sql },
    });
    expect(res.status).toBe(200);
    const aircraftQuery = captured.find((c) =>
      c.text.includes("aircraft_registry_current"),
    );
    expect(aircraftQuery).toBeDefined();
    // Last bind position is the limit; AC3 says clamp to 25.
    expect(aircraftQuery!.values).toContain(25);
  });

  it("AC3: returns 400 for limit=abc", async () => {
    const res = await handleFaaSearch(searchRequest("q=N1&limit=abc"), {
      lookupDeps: { sql: stubSql(async () => []) },
    });
    expect(res.status).toBe(400);
  });

  it("AC3: returns 400 for limit=0", async () => {
    const res = await handleFaaSearch(searchRequest("q=N1&limit=0"), {
      lookupDeps: { sql: stubSql(async () => []) },
    });
    expect(res.status).toBe(400);
  });

  it("AC3: applies default limit=10 when not provided", async () => {
    const captured: CapturedQuery[] = [];
    const sql = stubSql(
      async (q) => {
        if (q.includes("snapshot_manifest")) return [FRESHNESS_ROW];
        return [];
      },
      captured,
    );
    const res = await handleFaaSearch(searchRequest("q=N1"), {
      lookupDeps: { sql },
    });
    expect(res.status).toBe(200);
    const aircraftQuery = captured.find((c) =>
      c.text.includes("aircraft_registry_current"),
    );
    expect(aircraftQuery!.values).toContain(10);
  });

  it("AC5: binds q+% as a parameter, never interpolates raw user input into SQL", async () => {
    const captured: CapturedQuery[] = [];
    const sql = stubSql(
      async (q) => {
        if (q.includes("snapshot_manifest")) return [FRESHNESS_ROW];
        return [];
      },
      captured,
    );
    const res = await handleFaaSearch(searchRequest("q=N123"), {
      lookupDeps: { sql },
    });
    expect(res.status).toBe(200);
    const aircraftQuery = captured.find((c) =>
      c.text.includes("aircraft_registry_current"),
    );
    expect(aircraftQuery).toBeDefined();
    // q "N123" normalizes to "123"; pattern bound as "123%" (no wildcard in SQL).
    expect(aircraftQuery!.values).toContain("123%");
    // User-controlled chars must not appear inline in the SQL template.
    expect(aircraftQuery!.text).not.toContain("123");
    expect(aircraftQuery!.text.toLowerCase()).toContain("like");
  });

  it("normalizes lowercase 'n' prefix the same as uppercase", async () => {
    const captured: CapturedQuery[] = [];
    const sql = stubSql(
      async (q) => {
        if (q.includes("snapshot_manifest")) return [FRESHNESS_ROW];
        return [];
      },
      captured,
    );
    const res = await handleFaaSearch(searchRequest("q=n12"), {
      lookupDeps: { sql },
    });
    expect(res.status).toBe(200);
    const aircraftQuery = captured.find((c) =>
      c.text.includes("aircraft_registry_current"),
    );
    expect(aircraftQuery!.values).toContain("12%");
  });

  it("returns 503 + lookup_unavailable when the FAA query throws", async () => {
    const sql = stubSql(async () => {
      throw new Error("FAA pool exhausted");
    });
    const res = await handleFaaSearch(searchRequest("q=N1"), {
      lookupDeps: { sql },
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.kind).toBe("lookup_unavailable");
    expect(body.error_kind).toBe("server_error");
  });
});
