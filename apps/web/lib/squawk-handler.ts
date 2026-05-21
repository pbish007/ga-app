import { NextResponse } from "next/server";

import {
  SQUAWK_SEVERITIES,
  type Squawk,
  type SquawkPhoto,
  type SquawkSeverity,
} from "@ga/db";
import {
  SquawkAircraftNotFoundError,
  SquawkAlreadyResolvedError,
  SquawkNotFoundError,
  SquawkPhotoCrossTenantError,
  SquawkService,
  SquawkValidationError,
  type AircraftDb,
} from "@ga/aircraft";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function serializeSquawk(s: Squawk) {
  return {
    id: s.id,
    tenant_id: s.tenantId,
    aircraft_id: s.aircraftId,
    description: s.description,
    occurred_at: s.occurredAt.toISOString(),
    reporter_user_id: s.reporterUserId,
    severity: s.severity,
    status: s.status,
    resolved_at: s.resolvedAt?.toISOString() ?? null,
    resolved_by_user_id: s.resolvedByUserId,
    resolution_notes: s.resolutionNotes,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
  };
}

function serializePhoto(p: SquawkPhoto) {
  return {
    id: p.id,
    document_id: p.documentId,
    created_at: p.createdAt.toISOString(),
  };
}

interface FileSquawkBody {
  description?: unknown;
  severity?: unknown;
  occurred_at?: unknown;
  photo_document_ids?: unknown;
}

interface ResolveSquawkBody {
  resolution_notes?: unknown;
}

function asSeverity(value: unknown): SquawkSeverity | null {
  if (typeof value !== "string") return null;
  return (SQUAWK_SEVERITIES as readonly string[]).includes(value)
    ? (value as SquawkSeverity)
    : null;
}

/**
 * POST /api/orgs/{tenantId}/aircraft/{id}/squawks — file a squawk.
 *
 * Body (JSON):
 *   - description (string, required, non-empty)
 *   - severity    (one of informational | deferred | grounding)
 *   - occurred_at (ISO timestamp; defaults to now)
 *   - photo_document_ids (string[] of document UUIDs, optional)
 *
 * Photos are pre-uploaded via POST /api/attachments and then referenced
 * here by document id. The server validates that every document belongs
 * to the same tenant before linking it.
 */
export async function handleSquawkCreate(
  request: Request,
  ctx: {
    tenantId: string;
    userId: string;
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

  let body: FileSquawkBody;
  try {
    body = (await request.json()) as FileSquawkBody;
  } catch {
    return NextResponse.json(
      { error: "request body must be JSON" },
      { status: 400 },
    );
  }

  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  if (!description) {
    return NextResponse.json(
      { error: "description is required" },
      { status: 400 },
    );
  }

  const severity = asSeverity(body.severity);
  if (!severity) {
    return NextResponse.json(
      {
        error: `severity must be one of ${SQUAWK_SEVERITIES.join(", ")}`,
      },
      { status: 400 },
    );
  }

  let occurredAt: Date | undefined;
  if (body.occurred_at !== undefined && body.occurred_at !== null) {
    if (typeof body.occurred_at !== "string") {
      return NextResponse.json(
        { error: "occurred_at must be an ISO timestamp string" },
        { status: 400 },
      );
    }
    const parsed = new Date(body.occurred_at);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json(
        { error: "occurred_at is not a valid ISO timestamp" },
        { status: 400 },
      );
    }
    occurredAt = parsed;
  }

  let photoDocumentIds: string[] = [];
  if (body.photo_document_ids !== undefined) {
    if (!Array.isArray(body.photo_document_ids)) {
      return NextResponse.json(
        { error: "photo_document_ids must be an array of UUID strings" },
        { status: 400 },
      );
    }
    for (const raw of body.photo_document_ids) {
      if (typeof raw !== "string" || !UUID_RE.test(raw)) {
        return NextResponse.json(
          { error: "photo_document_ids must contain canonical UUIDs" },
          { status: 400 },
        );
      }
      photoDocumentIds.push(raw.toLowerCase());
    }
  }

  const svc = new SquawkService(ctx.db);
  try {
    const { squawk, photos } = await svc.file({
      tenantId: ctx.tenantId,
      aircraftId,
      description,
      severity,
      occurredAt,
      reporterUserId: ctx.userId,
      photoDocumentIds,
    });
    return NextResponse.json(
      {
        ...serializeSquawk(squawk),
        photos: photos.map(serializePhoto),
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof SquawkValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof SquawkAircraftNotFoundError) {
      return NextResponse.json({ error: "aircraft not found" }, { status: 404 });
    }
    if (err instanceof SquawkPhotoCrossTenantError) {
      return NextResponse.json(
        { error: "one or more photo documents do not belong to this tenant" },
        { status: 400 },
      );
    }
    throw err;
  }
}

/**
 * GET /api/orgs/{tenantId}/aircraft/{id}/squawks — list squawks for an
 * aircraft, newest occurrence first.
 */
export async function handleSquawkList(
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
  const svc = new SquawkService(ctx.db);
  const rows = await svc.listForAircraft(ctx.tenantId, aircraftId);
  return NextResponse.json(
    { squawks: rows.map(serializeSquawk) },
    { status: 200 },
  );
}

/**
 * POST /api/orgs/{tenantId}/squawks/{squawkId}/resolve — mark a squawk
 * resolved. Persists the resolving user and an optional narrative.
 *
 * Idempotency: a second resolve attempt returns 409 (already_resolved)
 * so a UI double-submit does not silently overwrite the resolution.
 */
export async function handleSquawkResolve(
  request: Request,
  ctx: {
    tenantId: string;
    userId: string;
    db: AircraftDb;
    params: { squawkId: string };
  },
): Promise<Response> {
  const squawkId = ctx.params.squawkId?.toLowerCase() ?? "";
  if (!UUID_RE.test(squawkId)) {
    return NextResponse.json(
      { error: "path parameter `squawkId` must be a canonical UUID" },
      { status: 400 },
    );
  }

  let body: ResolveSquawkBody = {};
  try {
    if (request.headers.get("content-length") !== "0") {
      body = (await request.json()) as ResolveSquawkBody;
    }
  } catch {
    return NextResponse.json(
      { error: "request body must be JSON when present" },
      { status: 400 },
    );
  }

  const resolutionNotes =
    typeof body.resolution_notes === "string"
      ? body.resolution_notes.trim() || null
      : null;

  const svc = new SquawkService(ctx.db);
  try {
    const row = await svc.resolve({
      tenantId: ctx.tenantId,
      squawkId,
      resolvedByUserId: ctx.userId,
      resolutionNotes,
    });
    return NextResponse.json(serializeSquawk(row), { status: 200 });
  } catch (err) {
    if (err instanceof SquawkNotFoundError) {
      return NextResponse.json({ error: "squawk not found" }, { status: 404 });
    }
    if (err instanceof SquawkAlreadyResolvedError) {
      return NextResponse.json(
        { error: "squawk is already resolved", code: "already_resolved" },
        { status: 409 },
      );
    }
    throw err;
  }
}
