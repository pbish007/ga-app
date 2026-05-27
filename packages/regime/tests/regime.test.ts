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
      bundle.inspectionPrograms.map((p) => p.template.code).sort(),
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

    const annual = bundle.inspectionPrograms.find(
      (p) => p.template.code === "annual",
    );
    expect(annual?.template.cadenceKind).toBe("single");
    expect(annual?.intervals).toHaveLength(1);
    expect(annual?.intervals[0]?.kind).toBe("calendar");
    expect(annual?.intervals[0]?.unit).toBe("months");
    expect(Number(annual?.intervals[0]?.value)).toBe(12);

    const hundredHour = bundle.inspectionPrograms.find(
      (p) => p.template.code === "100_hour",
    );
    expect(hundredHour?.intervals[0]?.kind).toBe("hour");
    expect(Number(hundredHour?.intervals[0]?.value)).toBe(100);

    const progressive = bundle.inspectionPrograms.find(
      (p) => p.template.code === "progressive",
    );
    expect(progressive?.template.cadenceKind).toBe("custom");
    expect(progressive?.intervals).toHaveLength(0);

    expect(bundle.directiveSources.map((s) => s.code).sort()).toEqual(
      ["ad", "sb"],
    );

    const ia = bundle.credentialTypes.find((c) => c.code === "ia");
    expect(ia?.authorizesSignoff).toBe(true);
    expect(ia?.name).toContain("Inspection Authorization");

    expect(bundle.rtsTemplates.map((r) => r.code).sort()).toEqual(
      [
        "100_hour",
        "ad_compliance",
        "annual",
        "return_to_service_maintenance",
        "standard",
      ],
    );

    const lifetime = bundle.retentionRules.filter(
      (r) => r.retentionPeriodKind === "lifetime",
    );
    expect(lifetime.map((r) => r.recordKind).sort()).toEqual(
      ["ad_compliance", "annual_inspection", "major_repair", "regime_change"],
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
          cadenceKind: "single",
          intervals: [{ kind: "calendar", value: 12, unit: "months" }],
          description:
            "CAR 605.86: aircraft annual airworthiness inspection.",
        },
        {
          code: "elt",
          name: "ELT Inspection",
          cadenceKind: "single",
          intervals: [{ kind: "calendar", value: 12, unit: "months" }],
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
    expect(
      carsBundle.inspectionPrograms.map((p) => p.template.code).sort(),
    ).toEqual(["annual", "elt"]);
    expect(carsBundle.credentialTypes.every((c) => c.authorizesSignoff))
      .toBe(true);
    expect(carsBundle.retentionRules[0]?.retentionPeriodValue).toBe(8);
    expect(carsBundle.rtsTemplates[0]?.body).toContain(
      "applicable airworthiness requirements",
    );
    // Intervals round-trip too.
    const carsAnnual = carsBundle.inspectionPrograms.find(
      (p) => p.template.code === "annual",
    );
    expect(carsAnnual?.intervals[0]?.kind).toBe("calendar");
    expect(Number(carsAnnual?.intervals[0]?.value)).toBe(12);

    // And the seeded FAA regime is untouched by the CARS insert.
    const faa = await regimes.getByCode("FAA");
    expect(faa.name).toBe("Federal Aviation Administration");
    const faaBundle = await regimes.loadBundle(faa.id);
    expect(faaBundle.inspectionPrograms.length).toBeGreaterThan(0);
  });

  it("supports whichever-comes-first via multiple interval rows", async () => {
    const db = await setupTestDb();
    const regimes = new RegimeClient(db);

    const cars = await regimes.createBundle({
      code: "TEST-WCF",
      name: "Test Regime",
      jurisdiction: "Test",
      inspectionProgramTemplates: [
        {
          code: "engine_overhaul",
          name: "Engine TBO / Calendar (whichever comes first)",
          cadenceKind: "whichever_comes_first",
          intervals: [
            { kind: "hour", value: 2000, unit: "hours" },
            { kind: "calendar", value: 12, unit: "years" },
          ],
        },
      ],
    });
    const program = cars.inspectionPrograms[0];
    expect(program?.template.cadenceKind).toBe("whichever_comes_first");
    expect(program?.intervals).toHaveLength(2);
    const kinds = program?.intervals.map((i) => i.kind).sort();
    expect(kinds).toEqual(["calendar", "hour"]);
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
