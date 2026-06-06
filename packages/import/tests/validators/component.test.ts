import { describe, it, expect } from "vitest";

import { componentValidator } from "../../src/index.js";

import { makeCtx, makeRow } from "./helpers.js";

function validComponent(overrides: Record<string, unknown> = {}) {
  return {
    kind: "engine",
    serialNumber: "L-1234-A",
    make: "Lycoming",
    model: "O-320",
    tboHours: 2000,
    tboCalendarMonths: 144,
    cycleLimit: 5000,
    ...overrides,
  };
}

describe("componentValidator — happy path", () => {
  it("accepts a fully-populated engine component", () => {
    const { ctx } = makeCtx();
    const row = makeRow(2, validComponent());
    const result = componentValidator.validate(row, ctx);
    expect(result.status).toBe("valid");
    expect(result.errors).toEqual([]);
  });

  it("accepts the minimum shape (kind + serialNumber only)", () => {
    const { ctx } = makeCtx();
    const row = makeRow(2, {
      kind: "propeller",
      serialNumber: "P-001",
    });
    const result = componentValidator.validate(row, ctx);
    expect(result.status).toBe("valid");
  });

  it.each(["engine", "propeller", "appliance"])(
    "accepts kind=%s",
    (kind) => {
      const { ctx } = makeCtx();
      const row = makeRow(2, validComponent({ kind }));
      expect(componentValidator.validate(row, ctx).status).toBe("valid");
    },
  );
});

describe("componentValidator — required fields", () => {
  it("flags missing kind", () => {
    const { ctx } = makeCtx();
    const mapped = validComponent();
    delete (mapped as Record<string, unknown>).kind;
    const row = makeRow(2, mapped);
    expect(
      componentValidator
        .validate(row, ctx)
        .errors.find((e) => e.field === "kind")?.code,
    ).toBe("MISSING_REQUIRED_FIELD");
  });

  it("flags missing serialNumber", () => {
    const { ctx } = makeCtx();
    const mapped = validComponent();
    delete (mapped as Record<string, unknown>).serialNumber;
    const row = makeRow(2, mapped);
    expect(
      componentValidator
        .validate(row, ctx)
        .errors.find((e) => e.field === "serialNumber")?.code,
    ).toBe("MISSING_REQUIRED_FIELD");
  });

  it("rejects an unknown kind", () => {
    const { ctx } = makeCtx();
    const row = makeRow(2, validComponent({ kind: "transponder" }));
    expect(
      componentValidator
        .validate(row, ctx)
        .errors.find((e) => e.field === "kind")?.code,
    ).toBe("INVALID_ENUM");
  });
});

describe("componentValidator — life limits", () => {
  it.each(["tboHours", "tboCalendarMonths", "cycleLimit"])(
    "flags zero %s as LIFE_LIMIT_INVALID",
    (field) => {
      const { ctx } = makeCtx();
      const row = makeRow(2, validComponent({ [field]: 0 }));
      expect(
        componentValidator
          .validate(row, ctx)
          .errors.find((e) => e.field === field)?.code,
      ).toBe("LIFE_LIMIT_INVALID");
    },
  );

  it.each(["tboHours", "tboCalendarMonths", "cycleLimit"])(
    "flags negative %s as LIFE_LIMIT_INVALID",
    (field) => {
      const { ctx } = makeCtx();
      const row = makeRow(2, validComponent({ [field]: -10 }));
      expect(
        componentValidator
          .validate(row, ctx)
          .errors.find((e) => e.field === field)?.code,
      ).toBe("LIFE_LIMIT_INVALID");
    },
  );

  it("flags a non-number tboHours as LIFE_LIMIT_INVALID", () => {
    const { ctx } = makeCtx();
    const row = makeRow(2, validComponent({ tboHours: "lots" }));
    expect(
      componentValidator
        .validate(row, ctx)
        .errors.find((e) => e.field === "tboHours")?.code,
    ).toBe("LIFE_LIMIT_INVALID");
  });

  it("accepts null life-limit fields (operator left blank)", () => {
    const { ctx } = makeCtx();
    const row = makeRow(2, {
      kind: "appliance",
      serialNumber: "X-1",
      tboHours: null,
      tboCalendarMonths: null,
      cycleLimit: null,
    });
    expect(componentValidator.validate(row, ctx).status).toBe("valid");
  });
});

describe("componentValidator — mapping errors", () => {
  it("folds upstream mapping errors and marks the row invalid", () => {
    const { ctx } = makeCtx();
    const row = makeRow(2, validComponent(), [
      {
        field: "tboHours",
        column: "TBO_HOURS",
        rowNumber: 2,
        code: "FORMAT_ERROR",
        message: "bad",
      },
    ]);
    const result = componentValidator.validate(row, ctx);
    expect(result.status).toBe("invalid");
    expect(
      result.errors.some((e) => e.code === "MAPPING_ERROR"),
    ).toBe(true);
  });
});
