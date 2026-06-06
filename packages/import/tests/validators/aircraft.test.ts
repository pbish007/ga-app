import { describe, it, expect } from "vitest";

import { aircraftValidator, FAA_REGISTRATION_REGEX } from "../../src/index.js";

import { makeCtx, makeRow, VALID_REGIME_ID } from "./helpers.js";

/**
 * C4 aircraft validator coverage. Asserts:
 *   - happy path on a fully-populated FAA row
 *   - required-field checks for each non-optional column
 *   - FAA grammar regex (positive + negative samples)
 *   - yearManufactured range mirrors aircraft_year_manufactured_range
 *   - airframeTotalTime non-negative
 *   - timeSource enum gate
 *   - mapping errors fold through as MAPPING_ERROR
 */

function validAircraft(overrides: Record<string, unknown> = {}) {
  return {
    regimeId: VALID_REGIME_ID,
    registration: "N12345",
    make: "Cessna",
    model: "172",
    serialNumber: "17280001",
    yearManufactured: 1978,
    category: "airplane",
    aircraftClass: "single_engine_land",
    airframeTotalTime: 4200.5,
    timeSource: "hobbs",
    ...overrides,
  };
}

describe("aircraftValidator — happy path", () => {
  it("accepts a fully-populated FAA aircraft row", () => {
    const { ctx } = makeCtx();
    const row = makeRow(2, validAircraft());
    const result = aircraftValidator.validate(row, ctx);
    expect(result.status).toBe("valid");
    expect(result.errors).toEqual([]);
  });

  it("accepts the minimum-length N-number 'N1'", () => {
    const { ctx } = makeCtx();
    const row = makeRow(2, validAircraft({ registration: "N1" }));
    const result = aircraftValidator.validate(row, ctx);
    expect(result.status).toBe("valid");
  });

  it("accepts the maximum-shape N-number 'N12345AB'", () => {
    const { ctx } = makeCtx();
    const row = makeRow(2, validAircraft({ registration: "N12345AB" }));
    const result = aircraftValidator.validate(row, ctx);
    expect(result.status).toBe("valid");
  });

  it("omits the optional yearManufactured + airframeTotalTime", () => {
    const { ctx } = makeCtx();
    const mapped = validAircraft() as Record<string, unknown>;
    delete mapped.yearManufactured;
    delete mapped.airframeTotalTime;
    const row = makeRow(2, mapped);
    const result = aircraftValidator.validate(row, ctx);
    expect(result.status).toBe("valid");
  });
});

describe("aircraftValidator — required fields", () => {
  it.each([
    "regimeId",
    "make",
    "model",
    "serialNumber",
    "category",
    "aircraftClass",
  ])("flags missing %s as MISSING_REQUIRED_FIELD", (field) => {
    const { ctx } = makeCtx();
    const mapped = validAircraft();
    delete (mapped as Record<string, unknown>)[field];
    const row = makeRow(2, mapped);
    const result = aircraftValidator.validate(row, ctx);
    expect(result.status).toBe("invalid");
    expect(
      result.errors.some(
        (e) => e.code === "MISSING_REQUIRED_FIELD" && e.field === field,
      ),
    ).toBe(true);
  });

  it("treats empty-string registration as missing", () => {
    const { ctx } = makeCtx();
    const row = makeRow(2, validAircraft({ registration: "   " }));
    const result = aircraftValidator.validate(row, ctx);
    expect(result.status).toBe("invalid");
    expect(
      result.errors.find((e) => e.field === "registration")?.code,
    ).toBe("MISSING_REQUIRED_FIELD");
  });
});

describe("aircraftValidator — FAA registration regex", () => {
  it.each([
    "N0",      // leading zero forbidden
    "N",       // no digits
    "12345",   // missing N
    "n12345",  // lowercase n
    "N12345abc", // lowercase suffix and too long
    "N123456",   // 6 digits (too many)
    "N12345ABC", // 3 suffix letters (too many)
    "N1234-AB",  // dash forbidden
  ])("rejects '%s' as INVALID_REGISTRATION", (registration) => {
    const { ctx } = makeCtx();
    const row = makeRow(2, validAircraft({ registration }));
    const result = aircraftValidator.validate(row, ctx);
    expect(result.status).toBe("invalid");
    expect(
      result.errors.find((e) => e.field === "registration")?.code,
    ).toBe("INVALID_REGISTRATION");
  });

  it.each(["N1", "N12345", "N1A", "N12345A", "N12345AB"])(
    "accepts '%s' under FAA grammar",
    (registration) => {
      const { ctx } = makeCtx();
      const row = makeRow(2, validAircraft({ registration }));
      const result = aircraftValidator.validate(row, ctx);
      expect(result.status).toBe("valid");
    },
  );

  it("matches the spec literal exactly", () => {
    expect(FAA_REGISTRATION_REGEX.source).toBe(
      "^N[1-9][0-9]{0,4}[A-Z]{0,2}$",
    );
  });

  it("uses the regime catalog regex when provided", () => {
    // Imaginary EASA-style: starts with a country letter group + digits.
    const easa = /^G-[A-Z]{4}$/;
    const { ctx } = makeCtx({
      regime: {
        regimeId: "easa",
        code: "EASA",
        registrationRegex: easa,
        rts: { regimeId: "easa", codes: new Set() },
      },
    });
    const ok = makeRow(2, validAircraft({ registration: "G-ABCD" }));
    expect(aircraftValidator.validate(ok, ctx).status).toBe("valid");
    const bad = makeRow(3, validAircraft({ registration: "N12345" }));
    expect(aircraftValidator.validate(bad, ctx).status).toBe("invalid");
  });

  it("does only presence check when no regime regex is configured", () => {
    const { ctx } = makeCtx({
      regime: {
        regimeId: "novel",
        code: "NOVEL",
        rts: { regimeId: "novel", codes: new Set() },
      },
    });
    const row = makeRow(2, validAircraft({ registration: "anything-goes" }));
    expect(aircraftValidator.validate(row, ctx).status).toBe("valid");
  });
});

describe("aircraftValidator — numeric constraints", () => {
  it.each([1899, 2101, 99])("rejects yearManufactured %i as OUT_OF_RANGE", (year) => {
    const { ctx } = makeCtx();
    const row = makeRow(2, validAircraft({ yearManufactured: year }));
    const result = aircraftValidator.validate(row, ctx);
    expect(result.status).toBe("invalid");
    expect(
      result.errors.find((e) => e.field === "yearManufactured")?.code,
    ).toBe("OUT_OF_RANGE");
  });

  it("rejects negative airframeTotalTime as OUT_OF_RANGE", () => {
    const { ctx } = makeCtx();
    const row = makeRow(2, validAircraft({ airframeTotalTime: -0.01 }));
    const result = aircraftValidator.validate(row, ctx);
    expect(result.status).toBe("invalid");
    expect(
      result.errors.find((e) => e.field === "airframeTotalTime")?.code,
    ).toBe("OUT_OF_RANGE");
  });

  it("accepts airframeTotalTime of exactly 0", () => {
    const { ctx } = makeCtx();
    const row = makeRow(2, validAircraft({ airframeTotalTime: 0 }));
    const result = aircraftValidator.validate(row, ctx);
    expect(result.status).toBe("valid");
  });
});

describe("aircraftValidator — timeSource enum", () => {
  it("rejects an unknown timeSource value", () => {
    const { ctx } = makeCtx();
    const row = makeRow(2, validAircraft({ timeSource: "moon" }));
    const result = aircraftValidator.validate(row, ctx);
    expect(result.status).toBe("invalid");
    expect(
      result.errors.find((e) => e.field === "timeSource")?.code,
    ).toBe("INVALID_ENUM");
  });

  it("accepts both 'hobbs' and 'tach'", () => {
    const { ctx } = makeCtx();
    for (const value of ["hobbs", "tach"]) {
      const row = makeRow(2, validAircraft({ timeSource: value }));
      expect(aircraftValidator.validate(row, ctx).status).toBe("valid");
    }
  });

  it("flags missing timeSource", () => {
    const { ctx } = makeCtx();
    const mapped = validAircraft();
    delete (mapped as Record<string, unknown>).timeSource;
    const row = makeRow(2, mapped);
    expect(
      aircraftValidator
        .validate(row, ctx)
        .errors.find((e) => e.field === "timeSource")?.code,
    ).toBe("MISSING_REQUIRED_FIELD");
  });
});

describe("aircraftValidator — mapping errors", () => {
  it("folds upstream mapping errors as MAPPING_ERROR entries", () => {
    const { ctx } = makeCtx();
    const row = makeRow(2, validAircraft(), [
      {
        field: "make",
        column: "MAKE",
        rowNumber: 2,
        code: "FORMAT_ERROR",
        message: "bad",
      },
    ]);
    const result = aircraftValidator.validate(row, ctx);
    expect(result.status).toBe("invalid");
    expect(
      result.errors.some((e) => e.code === "MAPPING_ERROR"),
    ).toBe(true);
  });
});
