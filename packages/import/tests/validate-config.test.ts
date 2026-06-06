import { describe, expect, it } from "vitest";

import {
  type MappingConfig,
  validateMappingConfig,
} from "../src/index.js";

/**
 * PMB-159 / C3 — mapping config validator.
 *
 * Covers the explicit C3 acceptance criteria:
 *   - rejects unknown target fields
 *   - rejects mismatched required columns (missing required fields,
 *     missing source columns)
 *   - rejects unsupported formats
 *
 * Plus the structural guards the validator adds on top (target table
 * membership, lookup shape, duplicate sources, constant typing).
 */

describe("validateMappingConfig — structural", () => {
  it("accepts a minimal valid maintenance_entries config", () => {
    const cfg: MappingConfig = {
      version: "1",
      targetTable: "maintenance_entries",
      columns: {
        workPerformed: { source: "Description" },
        performedOn: {
          source: "Date",
          format: { kind: "date", format: "MM/DD/YYYY" },
        },
        aircraftTotalTime: { source: "TT", format: { kind: "decimal" } },
      },
      constants: { entryType: "maintenance" },
      lookups: [
        {
          kind: "aircraft_by_registration",
          target: "aircraftId",
          sourceColumn: "Tail #",
        },
      ],
    };
    const result = validateMappingConfig(cfg);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("rejects an unknown target table", () => {
    const result = validateMappingConfig({
      version: "1",
      // @ts-expect-error intentionally bad
      targetTable: "squawks",
      columns: {},
    });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain(
      "UNKNOWN_TARGET_TABLE",
    );
  });

  it("rejects an unsupported config version", () => {
    const result = validateMappingConfig({
      // @ts-expect-error intentionally bad
      version: "2",
      targetTable: "aircraft",
      columns: {},
    });
    expect(result.issues.map((i) => i.code)).toContain("INVALID_VERSION");
  });
});

describe("validateMappingConfig — unknown target field", () => {
  it("rejects a column mapping naming a field not in the catalog", () => {
    const result = validateMappingConfig({
      version: "1",
      targetTable: "aircraft",
      columns: {
        registration_code: { source: "Tail" },
      },
    });
    expect(result.issues.map((i) => i.code)).toContain(
      "UNKNOWN_TARGET_FIELD",
    );
  });

  it("rejects a constant naming a field not in the catalog", () => {
    const result = validateMappingConfig({
      version: "1",
      targetTable: "components",
      constants: { vintage: "1970" },
    });
    expect(result.issues.map((i) => i.code)).toContain(
      "UNKNOWN_TARGET_FIELD",
    );
  });

  it("rejects a lookup naming a field not in the catalog", () => {
    const result = validateMappingConfig({
      version: "1",
      targetTable: "maintenance_entries",
      lookups: [
        {
          kind: "aircraft_by_registration",
          target: "ownerId",
          sourceColumn: "Tail #",
        },
      ],
    });
    expect(result.issues.map((i) => i.code)).toContain(
      "UNKNOWN_TARGET_FIELD",
    );
  });
});

describe("validateMappingConfig — required fields", () => {
  it("flags a required field with no source", () => {
    const result = validateMappingConfig({
      version: "1",
      targetTable: "aircraft",
      columns: {
        registration: { source: "Tail" },
        make: { source: "Make" },
        model: { source: "Model" },
        serialNumber: { source: "SN" },
        category: { source: "Cat" },
        aircraftClass: { source: "Class" },
        // timeSource missing
      },
      lookups: [
        { kind: "regime_by_code", target: "regimeId", value: "FAA" },
      ],
    });
    const missing = result.issues.filter(
      (i) => i.code === "MISSING_REQUIRED_FIELD",
    );
    expect(missing.map((i) => i.message).join("\n")).toContain("timeSource");
  });

  it("ignores optional fields with no source", () => {
    // yearManufactured / airframeTotalTime are optional and omitted.
    const result = validateMappingConfig({
      version: "1",
      targetTable: "aircraft",
      columns: {
        registration: { source: "Tail" },
        make: { source: "Make" },
        model: { source: "Model" },
        serialNumber: { source: "SN" },
        category: { source: "Cat" },
        aircraftClass: { source: "Class" },
      },
      constants: { timeSource: "tach" },
      lookups: [
        { kind: "regime_by_code", target: "regimeId", value: "FAA" },
      ],
    });
    expect(result.ok).toBe(true);
  });
});

describe("validateMappingConfig — formats", () => {
  it("rejects unsupported column format kinds", () => {
    const result = validateMappingConfig({
      version: "1",
      targetTable: "maintenance_entries",
      columns: {
        // @ts-expect-error intentionally bad
        performedOn: { source: "Date", format: { kind: "epoch" } },
      },
    });
    expect(result.issues.map((i) => i.code)).toContain(
      "UNSUPPORTED_FORMAT",
    );
  });

  it("rejects a date format applied to a non-date target", () => {
    const result = validateMappingConfig({
      version: "1",
      targetTable: "aircraft",
      columns: {
        registration: { source: "Tail", format: { kind: "date" } },
      },
    });
    expect(result.issues.map((i) => i.code)).toContain(
      "FORMAT_TYPE_MISMATCH",
    );
  });

  it("rejects a decimal format applied to an integer target", () => {
    const result = validateMappingConfig({
      version: "1",
      targetTable: "components",
      columns: {
        tboCalendarMonths: { source: "Months", format: { kind: "decimal" } },
      },
    });
    expect(result.issues.map((i) => i.code)).toContain(
      "FORMAT_TYPE_MISMATCH",
    );
  });

  it("rejects an unsupported date subformat", () => {
    const result = validateMappingConfig({
      version: "1",
      targetTable: "maintenance_entries",
      columns: {
        performedOn: {
          source: "Date",
          // @ts-expect-error intentionally bad
          format: { kind: "date", format: "RFC2822" },
        },
      },
    });
    expect(result.issues.map((i) => i.code)).toContain(
      "UNSUPPORTED_DATE_FORMAT",
    );
  });
});

describe("validateMappingConfig — constants", () => {
  it("rejects an enum constant outside the closed vocabulary", () => {
    const result = validateMappingConfig({
      version: "1",
      targetTable: "components",
      constants: { kind: "wing" },
    });
    expect(result.issues.map((i) => i.code)).toContain(
      "INVALID_ENUM_CONSTANT",
    );
  });

  it("rejects a non-integer constant on an integer field", () => {
    const result = validateMappingConfig({
      version: "1",
      targetTable: "components",
      constants: { tboCalendarMonths: 24.5 },
    });
    expect(result.issues.map((i) => i.code)).toContain(
      "INVALID_CONSTANT_TYPE",
    );
  });

  it("rejects a string constant on a boolean field", () => {
    const result = validateMappingConfig({
      version: "1",
      targetTable: "flight_time_entries",
      constants: { isOverride: "true" },
    });
    expect(result.issues.map((i) => i.code)).toContain(
      "INVALID_CONSTANT_TYPE",
    );
  });
});

describe("validateMappingConfig — lookups", () => {
  it("rejects an unknown lookup kind", () => {
    const result = validateMappingConfig({
      version: "1",
      targetTable: "maintenance_entries",
      lookups: [
        // @ts-expect-error intentionally bad
        { kind: "pilot_by_email", target: "aircraftId", sourceColumn: "x" },
      ],
    });
    expect(result.issues.map((i) => i.code)).toContain(
      "INVALID_LOOKUP_KIND",
    );
  });

  it("requires componentKind on a component_by_serial lookup", () => {
    const result = validateMappingConfig({
      version: "1",
      targetTable: "maintenance_entries",
      lookups: [
        {
          kind: "component_by_serial",
          target: "inspectionProgramId",
          sourceColumn: "Comp SN",
        },
      ],
    });
    expect(result.issues.map((i) => i.code)).toContain(
      "MISSING_COMPONENT_KIND",
    );
  });

  it("requires a value on regime_by_code", () => {
    const result = validateMappingConfig({
      version: "1",
      targetTable: "aircraft",
      // @ts-expect-error intentionally bad: missing value
      lookups: [{ kind: "regime_by_code", target: "regimeId" }],
    });
    expect(result.issues.map((i) => i.code)).toContain("MISSING_LOOKUP_KEY");
  });

  it("rejects a lookup targeting a non-uuid field", () => {
    const result = validateMappingConfig({
      version: "1",
      targetTable: "aircraft",
      lookups: [
        {
          kind: "aircraft_by_registration",
          target: "registration",
          sourceColumn: "Tail #",
        },
      ],
    });
    expect(result.issues.map((i) => i.code)).toContain(
      "FORMAT_TYPE_MISMATCH",
    );
  });
});

describe("validateMappingConfig — duplicate sources", () => {
  it("rejects a field sourced by both columns and constants", () => {
    const result = validateMappingConfig({
      version: "1",
      targetTable: "aircraft",
      columns: { timeSource: { source: "TS" } },
      constants: { timeSource: "tach" },
    });
    expect(result.issues.map((i) => i.code)).toContain(
      "DUPLICATE_TARGET_FIELD",
    );
  });

  it("rejects a field sourced by both columns and a lookup", () => {
    const result = validateMappingConfig({
      version: "1",
      targetTable: "maintenance_entries",
      columns: { aircraftId: { source: "AC ID" } },
      lookups: [
        {
          kind: "aircraft_by_registration",
          target: "aircraftId",
          sourceColumn: "Tail",
        },
      ],
    });
    expect(result.issues.map((i) => i.code)).toContain(
      "DUPLICATE_TARGET_FIELD",
    );
  });
});

describe("validateMappingConfig — availableColumns", () => {
  it("rejects column mappings whose source column is missing from the upload", () => {
    const result = validateMappingConfig(
      {
        version: "1",
        targetTable: "aircraft",
        columns: {
          registration: { source: "Tail #" },
          make: { source: "Make" },
          model: { source: "Model" },
          serialNumber: { source: "SN" },
          category: { source: "Cat" },
          aircraftClass: { source: "Class" },
        },
        constants: { timeSource: "tach" },
        lookups: [
          { kind: "regime_by_code", target: "regimeId", value: "FAA" },
        ],
      },
      { availableColumns: ["Make", "Model", "SN", "Cat", "Class"] }, // Tail # missing
    );
    expect(result.issues.map((i) => i.code)).toContain(
      "MISSING_SOURCE_COLUMN",
    );
  });

  it("rejects column-driven lookups whose source column is missing", () => {
    const result = validateMappingConfig(
      {
        version: "1",
        targetTable: "maintenance_entries",
        columns: {
          workPerformed: { source: "Desc" },
          performedOn: { source: "Date" },
          aircraftTotalTime: { source: "TT" },
        },
        constants: { entryType: "maintenance" },
        lookups: [
          {
            kind: "aircraft_by_registration",
            target: "aircraftId",
            sourceColumn: "Tail",
          },
        ],
      },
      { availableColumns: ["Desc", "Date", "TT"] }, // "Tail" missing
    );
    expect(result.issues.map((i) => i.code)).toContain(
      "MISSING_SOURCE_COLUMN",
    );
  });
});
