import { eq } from "drizzle-orm";

import { schema as dbSchema } from "@ga/db";
import type { AccountsDb } from "@ga/accounts";

/**
 * Idempotent demo-seed library for the board-acceptance demo org. Called
 * by the admin reseed-demo route (POST /api/admin/tenants/:id/reseed-demo)
 * and gated in the admin UI by the org's DEMO_ORG_NAME / "(Demo)" suffix.
 *
 * Pre-V1 the seed was driven by a one-shot `db-seed-demo` GH workflow that
 * also created the demo org + three demo users. V1 managed onboarding moved
 * tenant creation behind the admin API, so this module now only carries the
 * per-tenant content seed and the DEMO_ORG_NAME constant used by the UI gate.
 */

export const DEMO_ORG_NAME = "Blue Sky Aviation (Demo)";

/**
 * Idempotent demo seed for a tenant created via the admin API: given an
 * EXISTING tenant id, drops the tenant's aircraft-scoped demo data
 * (aircraft + subscriptions + flight time + open squawks + draft maintenance
 * entries) and re-inserts the canonical demo aircraft.
 *
 * Does NOT create users, an org, or memberships — those come from
 * `POST /api/admin/tenants`. The caller supplies the admin's user id as
 * the squawk reporter so the row's NOT NULL constraint is satisfied without
 * inventing demo users.
 *
 * Re-runs replace the prior aircraft/sub/squawk/entry rows for the tenant —
 * every call lands on the same content shape (one aircraft, four inspection
 * subscriptions in `ok`/`due_soon`/`overdue` states, one open grounding
 * squawk, one draft maintenance entry).
 */
const { aircraft, aircraftInspectionSubscriptions, flightTimeEntries, maintenanceEntries, regimeInspectionProgramTemplates, squawks } = dbSchema;

export interface SeedDemoContentInput {
  db: AccountsDb;
  tenantId: string;
  regimeId: string;
  /** Set as the squawk reporter + flight-time entry author. */
  reporterUserId: string;
  /** Override the clock in tests. */
  now?: () => Date;
}

export interface SeedDemoContentResult {
  aircraftId: string;
}

export async function seedDemoContent(
  input: SeedDemoContentInput,
): Promise<SeedDemoContentResult> {
  const clock = input.now ?? (() => new Date());
  const now = clock();

  const programRows = await input.db
    .select({
      code: regimeInspectionProgramTemplates.code,
      id: regimeInspectionProgramTemplates.id,
    })
    .from(regimeInspectionProgramTemplates)
    .where(eq(regimeInspectionProgramTemplates.regimeId, input.regimeId));
  const programByCode = new Map(programRows.map((r) => [r.code, r.id]));
  for (const code of ["annual", "100_hour", "elt", "transponder"] as const) {
    if (!programByCode.has(code)) {
      throw new Error(
        `regime ${input.regimeId} is missing the '${code}' inspection program template`,
      );
    }
  }

  // ON DELETE CASCADE on aircraft drops subs/flight-time/squawks/entries —
  // one delete per tenant is enough to clear the prior demo state.
  await input.db.delete(aircraft).where(eq(aircraft.tenantId, input.tenantId));

  const airframeTT = 4860.5;
  const ttPrev = (airframeTT - 1.5).toFixed(2);
  const ttCurrent = airframeTT.toFixed(2);
  const day = 24 * 60 * 60 * 1000;
  const daysAgoIso = (n: number) => new Date(now.getTime() - n * day);

  const [createdAircraft] = await input.db
    .insert(aircraft)
    .values({
      tenantId: input.tenantId,
      regimeId: input.regimeId,
      registration: "N172DEMO",
      make: "Cessna",
      model: "172S Skyhawk",
      serialNumber: "172S-DEMO-01",
      yearManufactured: 2014,
      category: "airplane",
      aircraftClass: "single-engine land",
      airframeTotalTime: ttCurrent,
      timeSource: "hobbs",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!createdAircraft) throw new Error("failed to insert demo aircraft");
  const aircraftId = createdAircraft.id;

  await input.db.insert(aircraftInspectionSubscriptions).values([
    {
      tenantId: input.tenantId,
      aircraftId,
      programId: programByCode.get("annual")!,
      lastCompliedAt: daysAgoIso(400),
      lastCompliedAirframeTime: (airframeTT - 92).toFixed(2),
      lastCompliedCycles: 0,
    },
    {
      tenantId: input.tenantId,
      aircraftId,
      programId: programByCode.get("100_hour")!,
      lastCompliedAt: daysAgoIso(120),
      lastCompliedAirframeTime: (airframeTT - 96).toFixed(2),
      lastCompliedCycles: 0,
    },
    {
      tenantId: input.tenantId,
      aircraftId,
      programId: programByCode.get("elt")!,
      lastCompliedAt: daysAgoIso(60),
      lastCompliedAirframeTime: (airframeTT - 40).toFixed(2),
      lastCompliedCycles: 0,
    },
    {
      tenantId: input.tenantId,
      aircraftId,
      programId: programByCode.get("transponder")!,
      lastCompliedAt: daysAgoIso(90),
      lastCompliedAirframeTime: (airframeTT - 60).toFixed(2),
      lastCompliedCycles: 0,
    },
  ]);

  await input.db.insert(flightTimeEntries).values({
    tenantId: input.tenantId,
    aircraftId,
    airframeTimeNew: ttCurrent,
    airframeTimePrev: ttPrev,
    enteredByUserId: input.reporterUserId,
  });

  await input.db.insert(squawks).values({
    tenantId: input.tenantId,
    aircraftId,
    description:
      "Right main landing gear tire worn beyond service limit; cords visible. Aircraft grounded pending replacement.",
    occurredAt: daysAgoIso(2),
    reporterUserId: input.reporterUserId,
    severity: "grounding",
    status: "open",
  });

  await input.db.insert(maintenanceEntries).values({
    tenantId: input.tenantId,
    aircraftId,
    entryType: "annual_inspection",
    workPerformed:
      "Annual inspection per 14 CFR 91.409(a). Replaced #2 cylinder, serviced brakes, ELT battery and function check. Ready for return-to-service sign-off.",
    performedOn: now.toISOString().slice(0, 10),
    aircraftTotalTime: ttCurrent,
    inspectionProgramId: programByCode.get("annual")!,
  });

  return { aircraftId };
}
