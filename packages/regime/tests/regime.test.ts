import { describe, expect, it } from "vitest";

import { setupTestDb } from "@ga/db";

import { RegimeClient, DEFAULT_REGIME_CODE } from "../src/index.js";

describe("regime spine (PMB-8 / Epic K)", () => {
  it("seeds the FAA regime from the first migration", async () => {
    const db = await setupTestDb();
    const regimes = new RegimeClient(db);

    const faa = await regimes.getByCode(DEFAULT_REGIME_CODE);
    expect(faa.code).toBe("FAA");
    expect(faa.name).toBe("Federal Aviation Administration");
    expect(faa.jurisdiction).toBe("United States of America");
    expect(faa.active).toBe(true);

    const bundle = await regimes.loadBundle(faa.id);
    expect(
      bundle.inspectionProgramTemplates.map((t) => t.code).sort(),
    ).toEqual(
      [
        "100_hour",
        "altimeter",
        "annual",
        "elt",
        "pitot_static",
        "progressive",
        "transponder",
      ].sort(),
    );

    const annual = bundle.inspectionProgramTemplates.find(
      (t) => t.code === "annual",
    );
    expect(annual?.cadenceKind).toBe("calendar");
    expect(annual?.intervalUnit).toBe("months");
    expect(Number(annual?.intervalValue)).toBe(12);

    expect(bundle.directiveSources.map((s) => s.code).sort()).toEqual(
      ["ad", "sb"],
    );

    const ia = bundle.credentialTypes.find((c) => c.code === "ia");
    expect(ia?.authorizesSignoff).toBe(true);
    expect(ia?.name).toContain("Inspection Authorization");

    expect(bundle.rtsTemplates.map((r) => r.code).sort()).toEqual(
      ["100_hour", "annual", "standard"],
    );

    const lifetime = bundle.retentionRules.filter(
      (r) => r.retentionPeriodKind === "lifetime",
    );
    expect(lifetime.map((r) => r.recordKind).sort()).toEqual(
      ["ad_compliance", "annual_inspection", "major_repair"],
    );
  });

  it("adding a CARS regime is a data-only operation (no migration)", async () => {
    // Boot the database. Only migration 0001 has run; no CARS-specific
    // migration exists. The fact that this whole test succeeds with a
    // pure series of INSERTs is the K1 seam acceptance criterion.
    const db = await setupTestDb();
    const regimes = new RegimeClient(db);

    expect((await regimes.list()).map((r) => r.code)).toEqual(["FAA"]);

    const cars = await regimes.createBundle({
      code: "CARS",
      name: "Canadian Aviation Regulations",
      jurisdiction: "Canada",
      inspectionProgramTemplates: [
        {
          code: "annual",
          name: "Annual Airworthiness Inspection",
          cadenceKind: "calendar",
          intervalValue: 12,
          intervalUnit: "months",
          description:
            "CAR 605.86: aircraft annual airworthiness inspection.",
        },
        {
          code: "elt",
          name: "ELT Inspection",
          cadenceKind: "calendar",
          intervalValue: 12,
          intervalUnit: "months",
          description: "CAR 571.10 annual ELT inspection.",
        },
      ],
      directiveSources: [
        {
          code: "ad",
          name: "Transport Canada Airworthiness Directive",
          description: "Mandatory TC-issued airworthiness directives.",
        },
        {
          code: "sb",
          name: "Manufacturer Service Bulletin",
        },
      ],
      credentialTypes: [
        {
          code: "ame_m1",
          name: "AME Category M1 (small aircraft)",
          authorizesSignoff: true,
        },
        {
          code: "ame_m2",
          name: "AME Category M2 (large aircraft)",
          authorizesSignoff: true,
        },
      ],
      rtsTemplates: [
        {
          code: "standard",
          name: "CARS Maintenance Release (CAR 571.10)",
          body:
            "The described maintenance has been performed in accordance with the applicable airworthiness requirements.",
        },
      ],
      retentionRules: [
        {
          recordKind: "maintenance_log",
          retentionPeriodKind: "years",
          retentionPeriodValue: 8,
          description: "CAR 605.95: minimum 8 years.",
        },
      ],
    });

    // The new regime is now first-class data with no schema migration.
    const list = await regimes.list();
    expect(list.map((r) => r.code).sort()).toEqual(["CARS", "FAA"]);
    expect(cars.regime.jurisdiction).toBe("Canada");

    // CARS-specific templates round-trip correctly via the typed accessor.
    const carsBundle = await regimes.loadBundle(cars.regime.id);
    expect(carsBundle.inspectionProgramTemplates.map((t) => t.code).sort())
      .toEqual(["annual", "elt"]);
    expect(carsBundle.credentialTypes.every((c) => c.authorizesSignoff))
      .toBe(true);
    expect(carsBundle.retentionRules[0]?.retentionPeriodValue).toBe(8);
    expect(carsBundle.rtsTemplates[0]?.body).toContain(
      "applicable airworthiness requirements",
    );

    // And the seeded FAA regime is untouched by the CARS insert.
    const faa = await regimes.getByCode("FAA");
    expect(faa.name).toBe("Federal Aviation Administration");
    const faaBundle = await regimes.loadBundle(faa.id);
    expect(faaBundle.inspectionProgramTemplates.length).toBeGreaterThan(0);
  });

  it("regime lookup by missing code raises a typed error", async () => {
    const db = await setupTestDb();
    const regimes = new RegimeClient(db);

    await expect(regimes.getByCode("EASA")).rejects.toThrow(
      /regime not found: code=EASA/,
    );
    expect(await regimes.findByCode("EASA")).toBeNull();
  });
});
