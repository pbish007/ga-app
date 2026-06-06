import { describe, it, expect } from "vitest";

import { maintenanceEntryValidator } from "../../src/index.js";

import {
  InMemoryCursor,
  makeCtx,
  makeRow,
  makeRegime,
  VALID_AIRCRAFT_ID,
} from "./helpers.js";

const CERT_NUMBER = "A123456IA";
const RTS_TEMPLATE_CODE = "FAA_43_9";

function validMaintenance(overrides: Record<string, unknown> = {}) {
  return {
    aircraftId: VALID_AIRCRAFT_ID,
    entryType: "annual_inspection",
    workPerformed: "Annual inspection per FAR 43 Appendix D",
    performedOn: "2024-09-15",
    aircraftTotalTime: 4200.5,
    signedAt: "2024-09-15T18:30:00.000Z",
    signedByCertificateNumber: CERT_NUMBER,
    rtsTemplateCode: RTS_TEMPLATE_CODE,
    ...overrides,
  };
}

function seededCtx() {
  return makeCtx({
    cursor: new InMemoryCursor({
      credentials: {
        [CERT_NUMBER]: {
          credentialId: "cred-1",
          userId: "user-1",
        },
      },
    }),
  });
}

describe("maintenanceEntryValidator — happy path", () => {
  it("accepts a fully-signed historical row", () => {
    const { ctx } = seededCtx();
    const row = makeRow(2, validMaintenance());
    const result = maintenanceEntryValidator.validate(row, ctx);
    expect(result.status).toBe("valid");
    expect(result.errors).toEqual([]);
  });

  it("accepts a row whose rtsTemplateCode matches catalog case-insensitively", () => {
    const { ctx } = seededCtx();
    const row = makeRow(2, validMaintenance({ rtsTemplateCode: "faa_43_9" }));
    const result = maintenanceEntryValidator.validate(row, ctx);
    expect(result.status).toBe("valid");
  });
});

describe("maintenanceEntryValidator — sign-off shape", () => {
  it.each([
    ["signedAt"],
    ["signedByCertificateNumber"],
    ["rtsTemplateCode"],
  ])("flags missing %s as UNSIGNED_HISTORICAL", (field) => {
    const { ctx } = seededCtx();
    const mapped = validMaintenance();
    delete (mapped as Record<string, unknown>)[field];
    const row = makeRow(2, mapped);
    const result = maintenanceEntryValidator.validate(row, ctx);
    expect(result.status).toBe("invalid");
    const unsigned = result.errors.find((e) => e.code === "UNSIGNED_HISTORICAL");
    expect(unsigned).toBeDefined();
    expect(unsigned?.message).toContain(field);
  });

  it("emits exactly one UNSIGNED_HISTORICAL even when all three are missing", () => {
    const { ctx } = seededCtx();
    const row = makeRow(2, validMaintenance({
      signedAt: null,
      signedByCertificateNumber: null,
      rtsTemplateCode: null,
    }));
    const result = maintenanceEntryValidator.validate(row, ctx);
    const unsigned = result.errors.filter(
      (e) => e.code === "UNSIGNED_HISTORICAL",
    );
    expect(unsigned).toHaveLength(1);
    expect(unsigned[0]!.message).toContain("signedAt");
    expect(unsigned[0]!.message).toContain("signedByCertificateNumber");
    expect(unsigned[0]!.message).toContain("rtsTemplateCode");
  });

  it("rejects an rtsTemplateCode not in the regime catalog", () => {
    const { ctx } = seededCtx();
    const row = makeRow(
      2,
      validMaintenance({ rtsTemplateCode: "FAA_NOT_A_THING" }),
    );
    const result = maintenanceEntryValidator.validate(row, ctx);
    const unknown = result.errors.find(
      (e) => e.code === "UNKNOWN_RTS_TEMPLATE",
    );
    expect(unknown).toBeDefined();
    expect(unknown?.field).toBe("rtsTemplateCode");
  });

  it("rejects an unknown certificate number with UNKNOWN_CERTIFICATE", () => {
    const { ctx } = makeCtx({
      cursor: new InMemoryCursor({ credentials: {} }),
    });
    const row = makeRow(2, validMaintenance());
    const result = maintenanceEntryValidator.validate(row, ctx);
    const cert = result.errors.find((e) => e.code === "UNKNOWN_CERTIFICATE");
    expect(cert).toBeDefined();
    expect(cert?.field).toBe("signedByCertificateNumber");
  });

  it("accepts a certificate number whose seed key differs by case", () => {
    const { ctx } = makeCtx({
      cursor: new InMemoryCursor({
        credentials: {
          [CERT_NUMBER.toLowerCase()]: { credentialId: "c", userId: "u" },
        },
      }),
    });
    const row = makeRow(
      2,
      validMaintenance({ signedByCertificateNumber: CERT_NUMBER.toUpperCase() }),
    );
    expect(maintenanceEntryValidator.validate(row, ctx).status).toBe("valid");
  });
});

describe("maintenanceEntryValidator — base shape", () => {
  it.each([
    "aircraftId",
    "workPerformed",
    "performedOn",
  ])("flags missing %s as MISSING_REQUIRED_FIELD", (field) => {
    const { ctx } = seededCtx();
    const mapped = validMaintenance();
    delete (mapped as Record<string, unknown>)[field];
    const row = makeRow(2, mapped);
    const result = maintenanceEntryValidator.validate(row, ctx);
    expect(
      result.errors.find((e) => e.field === field)?.code,
    ).toBe("MISSING_REQUIRED_FIELD");
  });

  it("flags aircraftId that is not a uuid as INVALID_FORMAT", () => {
    const { ctx } = seededCtx();
    const row = makeRow(2, validMaintenance({ aircraftId: "not-a-uuid" }));
    expect(
      maintenanceEntryValidator
        .validate(row, ctx)
        .errors.find((e) => e.field === "aircraftId")?.code,
    ).toBe("INVALID_FORMAT");
  });

  it("flags missing entryType", () => {
    const { ctx } = seededCtx();
    const mapped = validMaintenance();
    delete (mapped as Record<string, unknown>).entryType;
    const row = makeRow(2, mapped);
    expect(
      maintenanceEntryValidator
        .validate(row, ctx)
        .errors.find((e) => e.field === "entryType")?.code,
    ).toBe("MISSING_REQUIRED_FIELD");
  });

  it("flags an unknown entryType as INVALID_ENUM", () => {
    const { ctx } = seededCtx();
    const row = makeRow(2, validMaintenance({ entryType: "potion_inspection" }));
    expect(
      maintenanceEntryValidator
        .validate(row, ctx)
        .errors.find((e) => e.field === "entryType")?.code,
    ).toBe("INVALID_ENUM");
  });

  it("flags missing aircraftTotalTime as MISSING_REQUIRED_FIELD", () => {
    const { ctx } = seededCtx();
    const mapped = validMaintenance();
    delete (mapped as Record<string, unknown>).aircraftTotalTime;
    const row = makeRow(2, mapped);
    expect(
      maintenanceEntryValidator
        .validate(row, ctx)
        .errors.find((e) => e.field === "aircraftTotalTime")?.code,
    ).toBe("MISSING_REQUIRED_FIELD");
  });

  it("rejects negative aircraftTotalTime as OUT_OF_RANGE", () => {
    const { ctx } = seededCtx();
    const row = makeRow(2, validMaintenance({ aircraftTotalTime: -1 }));
    expect(
      maintenanceEntryValidator
        .validate(row, ctx)
        .errors.find((e) => e.field === "aircraftTotalTime")?.code,
    ).toBe("OUT_OF_RANGE");
  });
});

describe("maintenanceEntryValidator — regime catalog", () => {
  it("uses the regime catalog from ctx (per-regime template sets)", () => {
    const { ctx } = makeCtx({
      cursor: new InMemoryCursor({
        credentials: {
          [CERT_NUMBER]: { credentialId: "c", userId: "u" },
        },
      }),
      regime: makeRegime({
        code: "CASR",
        rts: {
          regimeId: "casr",
          codes: new Set(["CASR_SIGN_OFF_AT_1234"]),
        },
      }),
    });

    const faaCode = makeRow(2, validMaintenance({ rtsTemplateCode: "FAA_43_9" }));
    expect(
      maintenanceEntryValidator
        .validate(faaCode, ctx)
        .errors.find((e) => e.code === "UNKNOWN_RTS_TEMPLATE"),
    ).toBeDefined();

    const casrCode = makeRow(
      2,
      validMaintenance({ rtsTemplateCode: "CASR_SIGN_OFF_AT_1234" }),
    );
    expect(maintenanceEntryValidator.validate(casrCode, ctx).status).toBe("valid");
  });
});

describe("maintenanceEntryValidator — mapping errors", () => {
  it("folds upstream mapping errors as MAPPING_ERROR entries", () => {
    const { ctx } = seededCtx();
    const row = makeRow(2, validMaintenance(), [
      {
        field: "aircraftId",
        column: "TAIL",
        rowNumber: 2,
        code: "LOOKUP_MISS",
        message: "no aircraft for N999X",
      },
    ]);
    const result = maintenanceEntryValidator.validate(row, ctx);
    expect(
      result.errors.some((e) => e.code === "MAPPING_ERROR"),
    ).toBe(true);
  });
});
