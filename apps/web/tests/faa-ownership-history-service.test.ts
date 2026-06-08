import { describe, expect, it } from "vitest";

import type { FaaSql } from "../lib/faa/client";
import { loadOwnershipHistory } from "../lib/faa/ownership-history";

/**
 * Same stub-template pattern as the lookup tests
 * (`tests/faa-lookup-handler.test.ts`). The router fn matches the
 * first text fragment by substring; that is stable across whitespace
 * shifts in the query template.
 */
function stubSql(
  router: (queryText: string) => Promise<unknown[]>,
): FaaSql {
  return ((strings: TemplateStringsArray) =>
    router(strings.join(" "))) as unknown as FaaSql;
}

describe("loadOwnershipHistory", () => {
  it("returns ordered events with freshness for a tail that has changes", async () => {
    const sql = stubSql(async (query) => {
      if (query.includes("snapshot_manifest")) {
        return [
          {
            snapshot_date: "2026-06-01",
            pg_loaded_at: "2026-06-01T03:00:00Z",
          },
        ];
      }
      if (query.includes("aircraft_changes")) {
        return [
          {
            snapshot_date: "2026-06-01",
            change_type: "address_change",
            old_value: { street: "1 Old St", city: "Old City" },
            new_value: { street: "2 New Ave", city: "New City" },
          },
          {
            snapshot_date: "2026-03-15",
            change_type: "ownership_transfer",
            old_value: { owner_name: "ACME LLC" },
            new_value: { owner_name: "BETA INC" },
          },
        ];
      }
      return [];
    });

    const result = await loadOwnershipHistory({ sql }, "12345");
    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.change_kind).toBe("address_change");
    expect(result.events[0]!.snapshot_date).toBe("2026-06-01");
    expect(result.events[1]!.change_kind).toBe("ownership_transfer");
    expect(result.events[1]!.previous_value).toEqual({ owner_name: "ACME LLC" });
    expect(result.events[1]!.new_value).toEqual({ owner_name: "BETA INC" });
    expect(result.freshness.pg_loaded_at).toBe("2026-06-01T03:00:00Z");
  });

  it("returns an empty events array and the live freshness for a tail with no changes", async () => {
    const sql = stubSql(async (query) => {
      if (query.includes("snapshot_manifest")) {
        return [
          { snapshot_date: "2026-06-01", pg_loaded_at: "2026-06-01T03:00:00Z" },
        ];
      }
      return [];
    });

    const result = await loadOwnershipHistory({ sql }, "98765");
    expect(result.events).toEqual([]);
    expect(result.freshness.pg_loaded_at).toBe("2026-06-01T03:00:00Z");
  });

  it("falls back to null freshness when the pipeline has never loaded", async () => {
    const sql = stubSql(async () => []);
    const result = await loadOwnershipHistory({ sql }, "12345");
    expect(result.events).toEqual([]);
    expect(result.freshness).toEqual({
      snapshot_date: null,
      pg_loaded_at: null,
    });
  });

  it("propagates SQL errors so the handler can map to 503", async () => {
    const sql = stubSql(async () => {
      throw new Error("FAA pool exhausted");
    });
    await expect(loadOwnershipHistory({ sql }, "12345")).rejects.toThrow(
      /FAA pool exhausted/,
    );
  });
});
