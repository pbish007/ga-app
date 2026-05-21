import { NextResponse } from "next/server";

import {
  MAINTENANCE_ENTRY_TYPES,
  type MaintenanceEntry,
  type MaintenanceEntryType,
} from "@ga/db";
import {
  MaintenanceEntryAircraftNotFoundError,
  MaintenanceEntryAlreadySignedError,
  MaintenanceEntryNotAuthorizedToSignError,
  MaintenanceEntryNotFoundError,
  MaintenanceEntryService,
  MaintenanceEntryTemplateNotFoundError,
  MaintenanceEntryValidationError,
  type AircraftDb,
} from "@ga/aircraft";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function serializeEntry(e: MaintenanceEntry) {
  return {
    id: e.id,
    tenant_id: e.tenantId,
    aircraft_id: e.aircraftId,
    entry_type: e.entryType,
    work_performed: e.workPerformed,
    performed_on: e.performedOn,
    aircraft_total_time: e.aircraftTotalTime,
    inspection_program_id: e.inspectionProgramId,
    correction_of_id: e.correctionOfId,
    signed_at: e.signedAt?.toISOString() ?? null,
    signed_by_user_id: e.signedByUserId,
    signed_by_credential_id: e.signedByCredentialId,
    signed_by_certificate_number: e.signedByCertificateNumber,
    rts_template_id: e.rtsTemplateId,
    rts_rendered_body: e.rtsRenderedBody,
    created_at: e.createdAt.toISOString(),
    updated_at: e.updatedAt.toISOString(),
  };
}

interface DraftBody {
  entry_type?: unknown;
  work_performed?: unknown;
  performed_on?: unknown;
  aircraft_total_time?: unknown;
  inspection_program_id?: unknown;
  correction_of_id?: unknown;
}

interface SignBody {
  rts_template_code?: unknown;
}

function asEntryType(value: unknown): MaintenanceEntryType | null {
  if (typeof value !== "string") return null;
  return (MAINTENANCE_ENTRY_TYPES as readonly string[]).includes(value)
    ? (value as MaintenanceEntryType)
    : null;
}

/**
 * POST /api/orgs/{tenantId}/aircraft/{id}/maintenance-entries — draft
 * an unsigned maintenance entry. Sign with POST .../sign.
 *
 * Body (JSON):
 *   - entry_type           (maintenance | annual_inspection | 100_hour_inspection | inspection_program | ad_compliance)
 *   - work_performed       (string, required, non-empty)
 *   - performed_on         (YYYY-MM-DD)
 *   - aircraft_total_time  (number >= 0)
 *   - inspection_program_id (UUID, optional)
 *   - correction_of_id     (UUID of a SIGNED prior entry, optional)
 */
export async function handleMaintenanceEntryDraft(
  request: Request,
  ctx: {
    tenantId: string;
    db: AircraftDb;
    params: { id: string };
  },
): Promise<Response> {
  const aircraftId = ctx.params.id?.toLowerCase() ?? "";
  if (!UUID_RE.test(aircraftId)) {
    return NextResponse.json(
      { error: "path parameter `id` must be a canonical UUID" },
      { status: 400 },
    );
  }

  let body: DraftBody;
  try {
    body = (await request.json()) as DraftBody;
  } catch {
    return NextResponse.json(
      { error: "request body must be JSON" },
      { status: 400 },
    );
  }

  const entryType = asEntryType(body.entry_type);
  if (!entryType) {
    return NextResponse.json(
      {
        error: `entry_type must be one of ${MAINTENANCE_ENTRY_TYPES.join(
          ", ",
        )}`,
      },
      { status: 400 },
    );
  }

  const workPerformed =
    typeof body.work_performed === "string" ? body.work_performed.trim() : "";
  if (!workPerformed) {
    return NextResponse.json(
      { error: "work_performed is required" },
      { status: 400 },
    );
  }

  if (typeof body.performed_on !== "string" || !ISO_DATE_RE.test(body.performed_on)) {
    return NextResponse.json(
      { error: "performed_on must be an ISO date (YYYY-MM-DD)" },
      { status: 400 },
    );
  }
  const performedOn = body.performed_on;

  const att = body.aircraft_total_time;
  const airframe = typeof att === "number" ? att : Number(att);
  if (!Number.isFinite(airframe) || airframe < 0) {
    return NextResponse.json(
      { error: "aircraft_total_time must be a non-negative number" },
      { status: 400 },
    );
  }

  let inspectionProgramId: string | null = null;
  if (body.inspection_program_id !== undefined && body.inspection_program_id !== null) {
    if (
      typeof body.inspection_program_id !== "string" ||
      !UUID_RE.test(body.inspection_program_id)
    ) {
      return NextResponse.json(
        { error: "inspection_program_id must be a canonical UUID" },
        { status: 400 },
      );
    }
    inspectionProgramId = body.inspection_program_id.toLowerCase();
  }

  let correctionOfId: string | null = null;
  if (body.correction_of_id !== undefined && body.correction_of_id !== null) {
    if (
      typeof body.correction_of_id !== "string" ||
      !UUID_RE.test(body.correction_of_id)
    ) {
      return NextResponse.json(
        { error: "correction_of_id must be a canonical UUID" },
        { status: 400 },
      );
    }
    correctionOfId = body.correction_of_id.toLowerCase();
  }

  const svc = new MaintenanceEntryService(ctx.db);
  try {
    const entry = await svc.draft({
      tenantId: ctx.tenantId,
      aircraftId,
      entryType,
      workPerformed,
      performedOn,
      aircraftTotalTime: airframe,
      inspectionProgramId,
      correctionOfId,
    });
    return NextResponse.json(serializeEntry(entry), { status: 201 });
  } catch (err) {
    if (err instanceof MaintenanceEntryValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof MaintenanceEntryAircraftNotFoundError) {
      return NextResponse.json(
        { error: "aircraft not found" },
        { status: 404 },
      );
    }
    if (err instanceof MaintenanceEntryNotFoundError) {
      return NextResponse.json(
        { error: "correction_of_id refers to an unknown entry" },
        { status: 400 },
      );
    }
    throw err;
  }
}

/**
 * GET /api/orgs/{tenantId}/aircraft/{id}/maintenance-entries — list
 * entries for an aircraft, newest performed_on first.
 */
export async function handleMaintenanceEntryList(
  _request: Request,
  ctx: {
    tenantId: string;
    db: AircraftDb;
    params: { id: string };
  },
): Promise<Response> {
  const aircraftId = ctx.params.id?.toLowerCase() ?? "";
  if (!UUID_RE.test(aircraftId)) {
    return NextResponse.json(
      { error: "path parameter `id` must be a canonical UUID" },
      { status: 400 },
    );
  }
  const svc = new MaintenanceEntryService(ctx.db);
  const rows = await svc.listForAircraft(ctx.tenantId, aircraftId);
  return NextResponse.json(
    { maintenance_entries: rows.map(serializeEntry) },
    { status: 200 },
  );
}

/**
 * POST /api/orgs/{tenantId}/maintenance-entries/{entryId}/sign — sign
 * a draft entry. Requires the calling user to hold an A2 credential
 * authorising sign-off under the aircraft's regime.
 *
 * Body (JSON, optional): { rts_template_code?: string }. If omitted,
 * the service picks the template by entry_type.
 *
 * Idempotency: a second sign attempt returns 409 (already_signed) so a
 * UI double-submit does not double-render the RTS body. Lacking a
 * sign-off credential returns 403 (not_authorised_to_sign).
 */
export async function handleMaintenanceEntrySign(
  request: Request,
  ctx: {
    tenantId: string;
    userId: string;
    db: AircraftDb;
    params: { entryId: string };
  },
): Promise<Response> {
  const entryId = ctx.params.entryId?.toLowerCase() ?? "";
  if (!UUID_RE.test(entryId)) {
    return NextResponse.json(
      { error: "path parameter `entryId` must be a canonical UUID" },
      { status: 400 },
    );
  }

  let body: SignBody = {};
  try {
    if (request.headers.get("content-length") !== "0") {
      body = (await request.json()) as SignBody;
    }
  } catch {
    return NextResponse.json(
      { error: "request body must be JSON when present" },
      { status: 400 },
    );
  }

  let rtsTemplateCode: string | undefined;
  if (body.rts_template_code !== undefined) {
    if (typeof body.rts_template_code !== "string") {
      return NextResponse.json(
        { error: "rts_template_code must be a string" },
        { status: 400 },
      );
    }
    rtsTemplateCode = body.rts_template_code;
  }

  const svc = new MaintenanceEntryService(ctx.db);
  try {
    const signed = await svc.sign({
      tenantId: ctx.tenantId,
      entryId,
      signedByUserId: ctx.userId,
      rtsTemplateCode,
    });
    return NextResponse.json(serializeEntry(signed), { status: 200 });
  } catch (err) {
    if (err instanceof MaintenanceEntryNotFoundError) {
      return NextResponse.json(
        { error: "maintenance entry not found" },
        { status: 404 },
      );
    }
    if (err instanceof MaintenanceEntryAlreadySignedError) {
      return NextResponse.json(
        { error: "entry is already signed", code: "already_signed" },
        { status: 409 },
      );
    }
    if (err instanceof MaintenanceEntryNotAuthorizedToSignError) {
      return NextResponse.json(
        {
          error: "user is not authorised to sign under this aircraft's regime",
          code: "not_authorised_to_sign",
        },
        { status: 403 },
      );
    }
    if (err instanceof MaintenanceEntryTemplateNotFoundError) {
      return NextResponse.json(
        { error: err.message, code: "rts_template_not_found" },
        { status: 400 },
      );
    }
    throw err;
  }
}

/**
 * GET /api/orgs/{tenantId}/maintenance-entries/{entryId} — single
 * entry fetch. Used by the sign-off confirmation screen and audit
 * trail browsers.
 */
export async function handleMaintenanceEntryGet(
  _request: Request,
  ctx: {
    tenantId: string;
    db: AircraftDb;
    params: { entryId: string };
  },
): Promise<Response> {
  const entryId = ctx.params.entryId?.toLowerCase() ?? "";
  if (!UUID_RE.test(entryId)) {
    return NextResponse.json(
      { error: "path parameter `entryId` must be a canonical UUID" },
      { status: 400 },
    );
  }
  const svc = new MaintenanceEntryService(ctx.db);
  try {
    const entry = await svc.getById(ctx.tenantId, entryId);
    return NextResponse.json(serializeEntry(entry), { status: 200 });
  } catch (err) {
    if (err instanceof MaintenanceEntryNotFoundError) {
      return NextResponse.json(
        { error: "maintenance entry not found" },
        { status: 404 },
      );
    }
    throw err;
  }
}
