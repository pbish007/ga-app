import { describe, it, expect } from "vitest";

import { createBatchState, flightTimeEntryValidator } from "../../src/index.js";

import { makeCtx, makeRow, VALID_AIRCRAFT_ID } from "./helpers.js";

const OTHER_AIRCRAFT_ID = "44444444-4444-4444-4444-444444444444";

function validFlightTime(overrides: Record<string, unknown> = {}) {
  return {
    aircraftId: VALID_AIRCRAFT_ID,
    airframeTimeNew: 4210.3,
    isOverride: false,
    overrideReason: null,
    enteredAt: "2024-09-15T18:30:00.000Z",
    ...overrides,
  };
}

describe("flightTimeEntryValidator — happy path", () => {
  it("accepts a fully-populated row with a fresh batch state", () => {
    const { ctx } = makeCtx();
    const row = makeRow(2, validFlightTime());
    const result = flightTimeEntryValidator.validate(row, ctx);
    expect(result.status).toBe("valid");
    expect(result.errors).toEqual([]);
  });

  it("accepts a row that omits isOverride (defaults to false)", () => {
    const { ctx } = makeCtx();
    const mapped = validFlightTime();
    delete (mapped as Record<string, unknown>).isOverride;
    const row = makeRow(2, mapped);
    expect(flightTimeEntryValidator.validate(row, ctx).status).toBe("valid");
  });
});

describe("flightTimeEntryValidator — aircraft resolution", () => {
  it("flags an unresolved aircraftId as AIRCRAFT_NOT_RESOLVED", () => {
    const { ctx } = makeCtx();
    const mapped = validFlightTime();
    delete (mapped as Record<string, unknown>).aircraftId;
    const row = makeRow(2, mapped);
    const result = flightTimeEntryValidator.validate(row, ctx);
    expect(
      result.errors.find((e) => e.field === "aircraftId")?.code,
    ).toBe("AIRCRAFT_NOT_RESOLVED");
  });

  it("flags a non-uuid aircraftId as INVALID_FORMAT", () => {
    const { ctx } = makeCtx();
    const row = makeRow(2, validFlightTime({ aircraftId: "not-a-uuid" }));
    expect(
      flightTimeEntryValidator
        .validate(row, ctx)
        .errors.find((e) => e.field === "aircraftId")?.code,
    ).toBe("INVALID_FORMAT");
  });
});

describe("flightTimeEntryValidator — airframeTimeNew", () => {
  it("flags missing airframeTimeNew", () => {
    const { ctx } = makeCtx();
    const mapped = validFlightTime();
    delete (mapped as Record<string, unknown>).airframeTimeNew;
    const row = makeRow(2, mapped);
    expect(
      flightTimeEntryValidator
        .validate(row, ctx)
        .errors.find((e) => e.field === "airframeTimeNew")?.code,
    ).toBe("MISSING_REQUIRED_FIELD");
  });

  it("flags negative airframeTimeNew as OUT_OF_RANGE", () => {
    const { ctx } = makeCtx();
    const row = makeRow(2, validFlightTime({ airframeTimeNew: -1 }));
    expect(
      flightTimeEntryValidator
        .validate(row, ctx)
        .errors.find((e) => e.field === "airframeTimeNew")?.code,
    ).toBe("OUT_OF_RANGE");
  });
});

describe("flightTimeEntryValidator — override semantics", () => {
  it("requires overrideReason when isOverride=true", () => {
    const { ctx } = makeCtx();
    const row = makeRow(
      2,
      validFlightTime({ isOverride: true, overrideReason: null }),
    );
    expect(
      flightTimeEntryValidator
        .validate(row, ctx)
        .errors.find((e) => e.field === "overrideReason")?.code,
    ).toBe("MISSING_REQUIRED_FIELD");
  });

  it("accepts isOverride=true with a reason", () => {
    const { ctx } = makeCtx();
    const row = makeRow(
      2,
      validFlightTime({
        isOverride: true,
        overrideReason: "hour-meter replacement",
      }),
    );
    expect(flightTimeEntryValidator.validate(row, ctx).status).toBe("valid");
  });
});

describe("flightTimeEntryValidator — monotonicity across batch", () => {
  it("accepts strictly-increasing rows for the same aircraft", () => {
    const batch = createBatchState();
    const { ctx } = makeCtx({ batch });
    for (const t of [100, 110, 120, 125.5, 130]) {
      const row = makeRow(2, validFlightTime({ airframeTimeNew: t }));
      expect(
        flightTimeEntryValidator.validate(row, ctx).status,
      ).toBe("valid");
    }
    expect(batch.highestAirframeTimeByAircraft.get(VALID_AIRCRAFT_ID)).toBe(
      130,
    );
  });

  it("accepts equal-to-prior rows (idempotent re-entry)", () => {
    const batch = createBatchState();
    const { ctx } = makeCtx({ batch });
    const a = makeRow(2, validFlightTime({ airframeTimeNew: 100 }));
    const b = makeRow(3, validFlightTime({ airframeTimeNew: 100 }));
    expect(flightTimeEntryValidator.validate(a, ctx).status).toBe("valid");
    expect(flightTimeEntryValidator.validate(b, ctx).status).toBe("valid");
  });

  it("flags a backwards row as MONOTONICITY_VIOLATION", () => {
    const batch = createBatchState();
    const { ctx } = makeCtx({ batch });
    const a = makeRow(2, validFlightTime({ airframeTimeNew: 100 }));
    const b = makeRow(3, validFlightTime({ airframeTimeNew: 95 }));
    expect(flightTimeEntryValidator.validate(a, ctx).status).toBe("valid");
    const result = flightTimeEntryValidator.validate(b, ctx);
    expect(result.status).toBe("invalid");
    expect(
      result.errors.find((e) => e.code === "MONOTONICITY_VIOLATION"),
    ).toBeDefined();
  });

  it("scopes monotonicity per aircraft", () => {
    const batch = createBatchState();
    const { ctx } = makeCtx({ batch });
    const a = makeRow(2, validFlightTime({ airframeTimeNew: 100 }));
    const b = makeRow(
      3,
      validFlightTime({
        aircraftId: OTHER_AIRCRAFT_ID,
        airframeTimeNew: 50,
      }),
    );
    expect(flightTimeEntryValidator.validate(a, ctx).status).toBe("valid");
    // Second aircraft starts at 50 — should be valid, not flagged by
    // aircraft #1's high-water mark.
    expect(flightTimeEntryValidator.validate(b, ctx).status).toBe("valid");
  });

  it("allows an explicit override to go backwards and resets cursor on later high", () => {
    const batch = createBatchState();
    const { ctx } = makeCtx({ batch });
    const a = makeRow(2, validFlightTime({ airframeTimeNew: 200 }));
    const b = makeRow(
      3,
      validFlightTime({
        airframeTimeNew: 50,
        isOverride: true,
        overrideReason: "hour-meter replacement",
      }),
    );
    const c = makeRow(4, validFlightTime({ airframeTimeNew: 220 }));
    expect(flightTimeEntryValidator.validate(a, ctx).status).toBe("valid");
    expect(flightTimeEntryValidator.validate(b, ctx).status).toBe("valid");
    expect(flightTimeEntryValidator.validate(c, ctx).status).toBe("valid");
    expect(batch.highestAirframeTimeByAircraft.get(VALID_AIRCRAFT_ID)).toBe(
      220,
    );
  });

  it("skips monotonicity entirely when batch state is omitted", () => {
    const { ctx } = makeCtx({ batch: undefined });
    const a = makeRow(2, validFlightTime({ airframeTimeNew: 200 }));
    const b = makeRow(3, validFlightTime({ airframeTimeNew: 50 }));
    expect(flightTimeEntryValidator.validate(a, ctx).status).toBe("valid");
    expect(flightTimeEntryValidator.validate(b, ctx).status).toBe("valid");
  });
});

describe("flightTimeEntryValidator — mapping errors", () => {
  it("folds upstream mapping errors as MAPPING_ERROR entries", () => {
    const { ctx } = makeCtx();
    const row = makeRow(2, validFlightTime(), [
      {
        field: "aircraftId",
        column: "TAIL",
        rowNumber: 2,
        code: "LOOKUP_MISS",
        message: "no aircraft for N999X",
      },
    ]);
    const result = flightTimeEntryValidator.validate(row, ctx);
    expect(
      result.errors.some((e) => e.code === "MAPPING_ERROR"),
    ).toBe(true);
    // Even though aircraftId is present here, MAPPING_ERROR alone is
    // enough to fail the row.
    expect(result.status).toBe("invalid");
  });
});
