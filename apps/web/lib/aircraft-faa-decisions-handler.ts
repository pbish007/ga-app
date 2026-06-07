import { NextResponse } from "next/server";

import {
  AircraftFaaDecisionAircraftNotFoundError,
  AircraftFaaDecisionService,
  AircraftFaaDecisionValidationError,
  type AircraftDb,
  type RecordFaaFieldDecisionInput,
} from "@ga/aircraft";
import {
  FAA_FIELD_DECISIONS,
  FAA_FIELD_KEYS,
  FAA_FIELD_REPORT_REASONS,
  type AircraftFaaFieldDecision,
  type FaaFieldDecision,
  type FaaFieldKey,
  type FaaFieldReportReason,
} from "@ga/db";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AircraftFaaDecisionsHandlerDeps {
  tenantId: string;
  decidedByUserId: string;
  db: AircraftDb;
  params: { id: string };
}

export async function handleAircraftFaaDecisionsList(
  _request: Request,
  ctx: AircraftFaaDecisionsHandlerDeps,
): Promise<Response> {
  const aircraftId = ctx.params.id?.toLowerCase() ?? "";
  if (!UUID_RE.test(aircraftId)) {
    return NextResponse.json(
      { error: "path parameter `id` must be a canonical UUID" },
      { status: 400 },
    );
  }

  const service = new AircraftFaaDecisionService(ctx.db);
  const rows = await service.listByAircraft(ctx.tenantId, aircraftId);
  return NextResponse.json(
    {
      decisions: rows.map(serializeDecision),
    },
    { status: 200 },
  );
}

interface RecordDecisionBody {
  field_key?: unknown;
  decision?: unknown;
  faa_value?: unknown;
  tenant_value?: unknown;
  report_reason?: unknown;
  report_note?: unknown;
}

export async function handleAircraftFaaDecisionsRecord(
  request: Request,
  ctx: AircraftFaaDecisionsHandlerDeps,
): Promise<Response> {
  const aircraftId = ctx.params.id?.toLowerCase() ?? "";
  if (!UUID_RE.test(aircraftId)) {
    return NextResponse.json(
      { error: "path parameter `id` must be a canonical UUID" },
      { status: 400 },
    );
  }

  let body: RecordDecisionBody;
  try {
    body = (await request.json()) as RecordDecisionBody;
  } catch {
    return NextResponse.json(
      { error: "request body must be JSON" },
      { status: 400 },
    );
  }

  const fieldKey = body.field_key;
  if (typeof fieldKey !== "string" || !FAA_FIELD_KEYS.includes(fieldKey as FaaFieldKey)) {
    return NextResponse.json(
      {
        error: `field_key must be one of: ${FAA_FIELD_KEYS.join(", ")}`,
      },
      { status: 400 },
    );
  }

  const decision = body.decision;
  if (
    typeof decision !== "string" ||
    !FAA_FIELD_DECISIONS.includes(decision as FaaFieldDecision)
  ) {
    return NextResponse.json(
      {
        error: `decision must be one of: ${FAA_FIELD_DECISIONS.join(", ")}`,
      },
      { status: 400 },
    );
  }

  const faaValue = optionalString(body.faa_value, "faa_value");
  if (faaValue instanceof Response) return faaValue;
  const tenantValue = optionalString(body.tenant_value, "tenant_value");
  if (tenantValue instanceof Response) return tenantValue;
  const reportNote = optionalString(body.report_note, "report_note");
  if (reportNote instanceof Response) return reportNote;

  let reportReason: FaaFieldReportReason | null = null;
  if (body.report_reason !== undefined && body.report_reason !== null) {
    if (
      typeof body.report_reason !== "string" ||
      !FAA_FIELD_REPORT_REASONS.includes(body.report_reason as FaaFieldReportReason)
    ) {
      return NextResponse.json(
        {
          error: `report_reason must be one of: ${FAA_FIELD_REPORT_REASONS.join(", ")}`,
        },
        { status: 400 },
      );
    }
    reportReason = body.report_reason as FaaFieldReportReason;
  }

  const input: RecordFaaFieldDecisionInput = {
    tenantId: ctx.tenantId,
    aircraftId,
    fieldKey: fieldKey as FaaFieldKey,
    decision: decision as FaaFieldDecision,
    faaValue: faaValue,
    tenantValue: tenantValue,
    reportReason,
    reportNote: reportNote,
    decidedByUserId: ctx.decidedByUserId,
  };

  const service = new AircraftFaaDecisionService(ctx.db);
  let row: AircraftFaaFieldDecision;
  try {
    row = await service.record(input);
  } catch (err) {
    if (err instanceof AircraftFaaDecisionAircraftNotFoundError) {
      return NextResponse.json(
        { error: "aircraft not found" },
        { status: 404 },
      );
    }
    if (err instanceof AircraftFaaDecisionValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  return NextResponse.json(
    { decision: serializeDecision(row) },
    { status: 200 },
  );
}

function serializeDecision(row: AircraftFaaFieldDecision) {
  return {
    id: row.id,
    aircraft_id: row.aircraftId,
    n_number: row.nNumber,
    field_key: row.fieldKey,
    decision: row.decision,
    faa_value: row.faaValue,
    faa_value_hash: row.faaValueHash,
    tenant_value: row.tenantValue,
    report_reason: row.reportReason,
    report_note: row.reportNote,
    decided_by_user_id: row.decidedByUserId,
    decided_at: row.decidedAt.toISOString(),
  };
}

function optionalString(value: unknown, field: string): string | null | Response {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    return NextResponse.json(
      { error: `${field} must be a string or null` },
      { status: 400 },
    );
  }
  return value;
}
