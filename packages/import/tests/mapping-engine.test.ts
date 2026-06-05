import { describe, expect, it } from "vitest";

import {
  InMemoryLookupAdapter,
  applyMapping,
  type MappingConfig,
} from "../src/index.js";

/**
 * PMB-159 / C3 — mapping engine apply path.
 *
 * Acceptance: "Unit tests cover all field types in MVP-covered
 * entities (maintenance_entry, aircraft, component, flight_time)".
 *
 * One golden-path mapping per entity exercises:
 *   - direct column mapping with at least one each of text/decimal/
 *     integer/date/enum/boolean as relevant to the entity;
 *   - constants over enum/text/boolean values;
 *   - lookups (regime_by_code on aircraft, aircraft_by_registration
 *     on maintenance + flight_time).
 *
 * Plus failure-path tests for format errors, lookup misses, lookup
 * adapter exceptions, and tenant-scoping correctness (the in-memory
 * adapter is per-test, mirroring how the production adapter is per-
 * tenant under RLS).
 */

const REGIME_ID = "11111111-1111-1111-1111-111111111111";
const AIRCRAFT_ID = "22222222-2222-2222-2222-222222222222";
const COMPONENT_ID = "33333333-3333-3333-3333-333333333333";
const PROGRAM_ID = "44444444-4444-4444-4444-444444444444";

function lookups(): InMemoryLookupAdapter {
  return new InMemoryLookupAdapter({
    aircraft: { "N12345": AIRCRAFT_ID, "N67890": AIRCRAFT_ID },
    regimes: { FAA: REGIME_ID },
    components: {
      "ENG-001": { kind: "engine", id: COMPONENT_ID },
    },
    inspectionPrograms: { ANNUAL: PROGRAM_ID },
  });
}

describe("applyMapping — aircraft entity (text, decimal, integer, enum, lookup, constants)", () => {
  it("maps a full aircraft row end-to-end", async () => {
    const cfg: MappingConfig = {
      version: "1",
      targetTable: "aircraft",
      columns: {
        registration: { source: "Tail" },
        make: { source: "Make" },
        model: { source: "Model" },
        serialNumber: { source: "SN" },
        yearManufactured: { source: "Year" },
        airframeTotalTime: { source: "TT" },
      },
      constants: {
        category: "airplane",
        aircraftClass: "single_engine_land",
        timeSource: "tach",
      },
      lookups: [
        { kind: "regime_by_code", target: "regimeId", value: "FAA" },
      ],
    };
    const row = {
      rowNumber: 2,
      raw_cells: {
        Tail: "N12345",
        Make: "Cessna",
        Model: " 172N ",
        SN: "17270001",
        Year: "1976",
        TT: "4,512.30",
      },
    };
    const out = await applyMapping(cfg, row, lookups());
    expect(out.errors).toEqual([]);
    expect(out.mapped).toEqual({
      registration: "N12345",
      make: "Cessna",
      model: "172N",
      serialNumber: "17270001",
      yearManufactured: 1976,
      airframeTotalTime: 4512.3,
      category: "airplane",
      aircraftClass: "single_engine_land",
      timeSource: "tach",
      regimeId: REGIME_ID,
    });
  });

  it("emits FORMAT_ERROR on a non-numeric decimal cell", async () => {
    const cfg: MappingConfig = {
      version: "1",
      targetTable: "aircraft",
      columns: { airframeTotalTime: { source: "TT" } },
      // (required fields intentionally not all present — engine doesn't
      // re-run validator)
    };
    const out = await applyMapping(
      cfg,
      { rowNumber: 5, raw_cells: { TT: "n/a" } },
      lookups(),
    );
    expect(out.mapped.airframeTotalTime).toBeUndefined();
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]!.code).toBe("FORMAT_ERROR");
    expect(out.errors[0]!.rowNumber).toBe(5);
    expect(out.errors[0]!.field).toBe("airframeTotalTime");
  });

  it("emits LOOKUP_MISS when the regime code is unknown", async () => {
    const cfg: MappingConfig = {
      version: "1",
      targetTable: "aircraft",
      lookups: [
        { kind: "regime_by_code", target: "regimeId", value: "EASA" },
      ],
    };
    const out = await applyMapping(
      cfg,
      { rowNumber: 2, raw_cells: {} },
      lookups(),
    );
    expect(out.errors[0]!.code).toBe("LOOKUP_MISS");
    expect(out.mapped.regimeId).toBeUndefined();
  });
});

describe("applyMapping — maintenance_entries entity (date, decimal, enum constant, lookup)", () => {
  it("maps a maintenance entry row using MM/DD/YYYY date format", async () => {
    const cfg: MappingConfig = {
      version: "1",
      targetTable: "maintenance_entries",
      columns: {
        workPerformed: { source: "Description" },
        performedOn: {
          source: "Date",
          format: { kind: "date", format: "MM/DD/YYYY" },
        },
        aircraftTotalTime: { source: "TT" },
      },
      constants: { entryType: "annual_inspection" },
      lookups: [
        {
          kind: "aircraft_by_registration",
          target: "aircraftId",
          sourceColumn: "Tail",
        },
        {
          kind: "inspection_program_by_code",
          target: "inspectionProgramId",
          sourceColumn: "Program",
        },
      ],
    };
    const out = await applyMapping(
      cfg,
      {
        rowNumber: 17,
        raw_cells: {
          Tail: "N12345",
          Description: "Annual inspection per CFR 91.409",
          Date: "03/14/2024",
          TT: "1234.5",
          Program: "ANNUAL",
        },
      },
      lookups(),
    );
    expect(out.errors).toEqual([]);
    expect(out.mapped).toEqual({
      workPerformed: "Annual inspection per CFR 91.409",
      performedOn: "2024-03-14",
      aircraftTotalTime: 1234.5,
      entryType: "annual_inspection",
      aircraftId: AIRCRAFT_ID,
      inspectionProgramId: PROGRAM_ID,
    });
  });

  it("defaults date format to ISO when none is declared", async () => {
    const cfg: MappingConfig = {
      version: "1",
      targetTable: "maintenance_entries",
      columns: { performedOn: { source: "Date" } },
    };
    const out = await applyMapping(
      cfg,
      { rowNumber: 3, raw_cells: { Date: "2024-12-31" } },
      lookups(),
    );
    expect(out.errors).toEqual([]);
    expect(out.mapped.performedOn).toBe("2024-12-31");
  });

  it("rejects a non-ISO cell when ISO format is in effect", async () => {
    const cfg: MappingConfig = {
      version: "1",
      targetTable: "maintenance_entries",
      columns: { performedOn: { source: "Date" } },
    };
    const out = await applyMapping(
      cfg,
      { rowNumber: 4, raw_cells: { Date: "12/31/2024" } },
      lookups(),
    );
    expect(out.errors[0]!.code).toBe("FORMAT_ERROR");
  });

  it("emits a row-scoped LOOKUP_MISS for an unknown tail number", async () => {
    const cfg: MappingConfig = {
      version: "1",
      targetTable: "maintenance_entries",
      lookups: [
        {
          kind: "aircraft_by_registration",
          target: "aircraftId",
          sourceColumn: "Tail",
        },
      ],
    };
    const out = await applyMapping(
      cfg,
      { rowNumber: 9, raw_cells: { Tail: "N99999" } },
      lookups(),
    );
    expect(out.errors[0]!.code).toBe("LOOKUP_MISS");
    expect(out.errors[0]!.rowNumber).toBe(9);
    expect(out.errors[0]!.field).toBe("aircraftId");
  });

  it("matches aircraft registration case-insensitively", async () => {
    const cfg: MappingConfig = {
      version: "1",
      targetTable: "maintenance_entries",
      lookups: [
        {
          kind: "aircraft_by_registration",
          target: "aircraftId",
          sourceColumn: "Tail",
        },
      ],
    };
    const out = await applyMapping(
      cfg,
      { rowNumber: 2, raw_cells: { Tail: "n12345" } },
      lookups(),
    );
    expect(out.errors).toEqual([]);
    expect(out.mapped.aircraftId).toBe(AIRCRAFT_ID);
  });
});

describe("applyMapping — components entity (enum column, integer, optional decimals)", () => {
  it("maps a component row with explicit kind column", async () => {
    const cfg: MappingConfig = {
      version: "1",
      targetTable: "components",
      columns: {
        kind: { source: "Kind" },
        serialNumber: { source: "SN" },
        make: { source: "Make" },
        model: { source: "Model" },
        tboHours: { source: "TBO Hrs" },
        tboCalendarMonths: { source: "TBO Mo" },
        cycleLimit: { source: "Cycles" },
      },
    };
    const out = await applyMapping(
      cfg,
      {
        rowNumber: 2,
        raw_cells: {
          Kind: "engine",
          SN: "ENG-001",
          Make: "Lycoming",
          Model: "O-320-E2D",
          "TBO Hrs": "2000",
          "TBO Mo": "144",
          Cycles: "",
        },
      },
      lookups(),
    );
    expect(out.errors).toEqual([]);
    expect(out.mapped).toEqual({
      kind: "engine",
      serialNumber: "ENG-001",
      make: "Lycoming",
      model: "O-320-E2D",
      tboHours: 2000,
      tboCalendarMonths: 144,
      // Cycles: "" → null → field absent
    });
    expect(out.mapped.cycleLimit).toBeUndefined();
  });

  it("rejects a non-integer cell for an integer field", async () => {
    const cfg: MappingConfig = {
      version: "1",
      targetTable: "components",
      columns: { tboCalendarMonths: { source: "Mo" } },
    };
    const out = await applyMapping(
      cfg,
      { rowNumber: 4, raw_cells: { Mo: "144.5" } },
      lookups(),
    );
    expect(out.errors[0]!.code).toBe("FORMAT_ERROR");
  });
});

describe("applyMapping — flight_time_entries entity (boolean, decimal, lookup)", () => {
  it("maps a flight time row with boolean override and a tail lookup", async () => {
    const cfg: MappingConfig = {
      version: "1",
      targetTable: "flight_time_entries",
      columns: {
        airframeTimeNew: { source: "Total Time" },
        isOverride: { source: "Override" },
        overrideReason: { source: "Reason" },
      },
      lookups: [
        {
          kind: "aircraft_by_registration",
          target: "aircraftId",
          sourceColumn: "Tail",
        },
      ],
    };
    const out = await applyMapping(
      cfg,
      {
        rowNumber: 2,
        raw_cells: {
          Tail: "N67890",
          "Total Time": "1234.5",
          Override: "yes",
          Reason: "instrument swap",
        },
      },
      lookups(),
    );
    expect(out.errors).toEqual([]);
    expect(out.mapped).toEqual({
      airframeTimeNew: 1234.5,
      isOverride: true,
      overrideReason: "instrument swap",
      aircraftId: AIRCRAFT_ID,
    });
  });

  it("accepts custom truthy/falsy lists for the boolean format", async () => {
    const cfg: MappingConfig = {
      version: "1",
      targetTable: "flight_time_entries",
      columns: {
        isOverride: {
          source: "Override",
          format: { kind: "boolean", truthy: ["X"], falsy: [""] },
        },
      },
    };
    const out = await applyMapping(
      cfg,
      { rowNumber: 2, raw_cells: { Override: "X" } },
      lookups(),
    );
    expect(out.errors).toEqual([]);
    expect(out.mapped.isOverride).toBe(true);
  });

  it("emits FORMAT_ERROR for an unrecognized boolean cell", async () => {
    const cfg: MappingConfig = {
      version: "1",
      targetTable: "flight_time_entries",
      columns: { isOverride: { source: "Override" } },
    };
    const out = await applyMapping(
      cfg,
      { rowNumber: 6, raw_cells: { Override: "maybe" } },
      lookups(),
    );
    expect(out.errors[0]!.code).toBe("FORMAT_ERROR");
  });
});

describe("applyMapping — adapter contract", () => {
  it("folds adapter exceptions into LOOKUP_ERROR rather than throwing", async () => {
    const exploding: InMemoryLookupAdapter = Object.assign(
      new InMemoryLookupAdapter(),
      {
        async aircraftIdByRegistration(): Promise<string | null> {
          throw new Error("db connection refused");
        },
      },
    );
    const cfg: MappingConfig = {
      version: "1",
      targetTable: "maintenance_entries",
      lookups: [
        {
          kind: "aircraft_by_registration",
          target: "aircraftId",
          sourceColumn: "Tail",
        },
      ],
    };
    const out = await applyMapping(
      cfg,
      { rowNumber: 7, raw_cells: { Tail: "N12345" } },
      exploding,
    );
    expect(out.errors[0]!.code).toBe("LOOKUP_ERROR");
    expect(out.errors[0]!.message).toContain("db connection refused");
  });

  it("isolates lookups across adapters (tenant scoping property)", async () => {
    const tenantA = new InMemoryLookupAdapter({
      aircraft: { "N12345": "aircraft-from-A" },
    });
    const tenantB = new InMemoryLookupAdapter({
      aircraft: { "N12345": "aircraft-from-B" },
    });
    const cfg: MappingConfig = {
      version: "1",
      targetTable: "maintenance_entries",
      lookups: [
        {
          kind: "aircraft_by_registration",
          target: "aircraftId",
          sourceColumn: "Tail",
        },
      ],
    };
    const row = { rowNumber: 2, raw_cells: { Tail: "N12345" } };
    const a = await applyMapping(cfg, row, tenantA);
    const b = await applyMapping(cfg, row, tenantB);
    expect(a.mapped.aircraftId).toBe("aircraft-from-A");
    expect(b.mapped.aircraftId).toBe("aircraft-from-B");
  });
});
