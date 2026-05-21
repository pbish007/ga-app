/**
 * D2.1 + D2.2 — Due-list endpoint and airworthiness rollup.
 *
 * Spec §3.6 disclaimer: this software reports compliance status only.
 * Airworthiness determination is the legal responsibility of the
 * certificated mechanic and the aircraft owner/operator.
 */

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import {
  computeProgramDue,
  rollupAirworthiness,
  type DueSoonThresholds,
  type IntervalDefinition,
  type IntervalDue,
  type ProgramDue,
} from "@ga/compliance";
import { schema } from "@ga/db";
import { SquawkService, type AircraftDb } from "@ga/aircraft";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DISCLAIMER =
  "Airworthiness determination is the legal responsibility of the certificated mechanic and the aircraft owner/operator. This software reports compliance status only.";

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

function serializeIntervalDue(d: IntervalDue) {
  return {
    interval: d.interval,
    due_at: d.dueAt?.toISOString() ?? null,
    due_at_airframe_time: d.dueAtAirframeTime,
    due_at_cycles: d.dueAtCycles,
    remaining_days: d.remainingDays !== null ? Math.round(d.remainingDays * 10) / 10 : null,
    remaining_hours: d.remainingHours !== null ? Math.round(d.remainingHours * 10) / 10 : null,
    remaining_cycles: d.remainingCycles,
    status: d.status,
  };
}

function serializeProgramDue(
  programId: string,
  programCode: string,
  programName: string,
  result: ProgramDue,
) {
  return {
    program_id: programId,
    program_code: programCode,
    program_name: programName,
    status: result.status,
    driver: result.driver ? serializeIntervalDue(result.driver) : null,
    intervals: result.intervals.map(serializeIntervalDue),
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleComplianceDueList(
  _request: Request,
  ctx: {
    tenantId: string;
    db: AircraftDb;
    params: { aircraftId: string };
  },
): Promise<Response> {
  const { aircraftId } = ctx.params;

  if (!UUID_RE.test(aircraftId)) {
    return NextResponse.json(
      { error: "path parameter `aircraftId` must be a canonical UUID" },
      { status: 400 },
    );
  }

  const db = ctx.db;

  // Fetch aircraft — RLS enforces tenant isolation.
  const aircraftRows = await db
    .select()
    .from(schema.aircraft)
    .where(
      and(
        eq(schema.aircraft.id, aircraftId),
        eq(schema.aircraft.tenantId, ctx.tenantId),
      ),
    );

  if (aircraftRows.length === 0) {
    return NextResponse.json({ error: "aircraft not found" }, { status: 404 });
  }

  const aircraft = aircraftRows[0]!;
  const airframeTime = Number(aircraft.airframeTotalTime);

  // Load active subscriptions.
  const subs = await db
    .select()
    .from(schema.aircraftInspectionSubscriptions)
    .where(
      and(
        eq(schema.aircraftInspectionSubscriptions.aircraftId, aircraftId),
        eq(schema.aircraftInspectionSubscriptions.tenantId, ctx.tenantId),
        eq(schema.aircraftInspectionSubscriptions.active, true),
      ),
    );

  // E1.3 — open grounding squawks make the aircraft not airworthy.
  // Read these alongside subscriptions so the response always carries
  // the same disclosure shape regardless of whether subscriptions exist.
  const squawkSvc = new SquawkService(db);
  const openGroundingSquawks = await squawkSvc.listOpenGroundingForAircraft(
    ctx.tenantId,
    aircraftId,
  );

  if (subs.length === 0) {
    const status =
      openGroundingSquawks.length > 0 ? "overdue" : "ok";
    return NextResponse.json({
      aircraft_id: aircraftId,
      airframe_total_time: airframeTime,
      airworthiness_status: status,
      open_grounding_squawks: openGroundingSquawks.map(serializeSquawkRef),
      disclaimer: DISCLAIMER,
      programs: [],
    });
  }

  const allProgramDues: ProgramDue[] = [];
  const programResults: ReturnType<typeof serializeProgramDue>[] = [];

  for (const sub of subs) {
    // Load the program template.
    const tplRows = await db
      .select()
      .from(schema.regimeInspectionProgramTemplates)
      .where(eq(schema.regimeInspectionProgramTemplates.id, sub.programId));

    if (tplRows.length === 0) continue;
    const tpl = tplRows[0]!;

    // Load interval rows for this program.
    const intervalRows = await db
      .select()
      .from(schema.regimeInspectionProgramIntervals)
      .where(eq(schema.regimeInspectionProgramIntervals.templateId, sub.programId));

    const intervals: IntervalDefinition[] = intervalRows.map((row) => ({
      kind: row.kind as IntervalDefinition["kind"],
      value: Number(row.value),
      unit: row.unit,
    }));

    const anchor = {
      at: sub.lastCompliedAt ?? sub.createdAt,
      airframeTime: sub.lastCompliedAirframeTime
        ? Number(sub.lastCompliedAirframeTime)
        : 0,
      cycles: sub.lastCompliedCycles ?? 0,
    };

    const current = {
      now: new Date(),
      airframeTime,
      cycles: 0,
    };

    const thresholds: DueSoonThresholds = {
      days: sub.dueSoonDaysThreshold,
      hours: Number(sub.dueSoonHoursThreshold),
    };

    const result = computeProgramDue(intervals, anchor, current, thresholds);
    allProgramDues.push(result);
    programResults.push(serializeProgramDue(tpl.id, tpl.code, tpl.name, result));
  }

  const inspectionStatus = rollupAirworthiness(allProgramDues);
  // Open grounding squawks force overdue regardless of inspection rollup.
  const airworthinessStatus =
    openGroundingSquawks.length > 0 ? "overdue" : inspectionStatus;

  return NextResponse.json({
    aircraft_id: aircraftId,
    airframe_total_time: airframeTime,
    airworthiness_status: airworthinessStatus,
    open_grounding_squawks: openGroundingSquawks.map(serializeSquawkRef),
    disclaimer: DISCLAIMER,
    programs: programResults,
  });
}

function serializeSquawkRef(sq: {
  id: string;
  description: string;
  occurredAt: Date;
}) {
  return {
    id: sq.id,
    description: sq.description,
    occurred_at: sq.occurredAt.toISOString(),
  };
}
