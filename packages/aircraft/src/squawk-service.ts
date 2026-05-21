import { and, desc, eq, sql } from "drizzle-orm";

import {
  SQUAWK_SEVERITIES,
  type Squawk,
  type SquawkPhoto,
  type SquawkSeverity,
  schema as dbSchema,
} from "@ga/db";

import type { AircraftDb } from "./db.js";

const { squawks, squawkPhotos, aircraft, documents } = dbSchema;

export class SquawkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SquawkValidationError";
  }
}

export class SquawkNotFoundError extends Error {
  constructor(criterion: string) {
    super(`squawk not found: ${criterion}`);
    this.name = "SquawkNotFoundError";
  }
}

export class SquawkAircraftNotFoundError extends Error {
  constructor(criterion: string) {
    super(`aircraft not found: ${criterion}`);
    this.name = "SquawkAircraftNotFoundError";
  }
}

export class SquawkAlreadyResolvedError extends Error {
  constructor(squawkId: string) {
    super(`squawk ${squawkId} is already resolved`);
    this.name = "SquawkAlreadyResolvedError";
  }
}

export class SquawkPhotoCrossTenantError extends Error {
  constructor(
    public readonly documentId: string,
    public readonly tenantId: string,
  ) {
    super(
      `document ${documentId} does not belong to tenant ${tenantId}`,
    );
    this.name = "SquawkPhotoCrossTenantError";
  }
}

export interface FileSquawkInput {
  tenantId: string;
  aircraftId: string;
  description: string;
  severity: SquawkSeverity;
  /** When the discrepancy was observed. Defaults to "now". */
  occurredAt?: Date;
  /** Author of the squawk; nullable so a CSV import has a path. */
  reporterUserId?: string | null;
  /** Document ids (from J2.1 attachments) to attach as photos. */
  photoDocumentIds?: string[];
}

export interface ResolveSquawkInput {
  tenantId: string;
  squawkId: string;
  resolvedByUserId?: string | null;
  resolutionNotes?: string | null;
  resolvedAt?: Date;
}

export interface SquawkWithPhotos {
  squawk: Squawk;
  photos: SquawkPhoto[];
}

/**
 * Domain service for E1 squawk reporting (PMB-13).
 *
 * Severity ladder: `informational` < `deferred` < `grounding`. An
 * `open` squawk with severity `grounding` makes the aircraft NOT
 * airworthy; the compliance dashboard reads `listOpenGroundingForAircraft`
 * to propagate that into the airworthiness indicator (E1.3).
 *
 * Tenant scoping is the caller's responsibility — wrap in `runAsTenant`
 * so RLS enforces isolation at the database. The service still passes
 * `tenantId` to every query for defense-in-depth.
 */
export class SquawkService {
  constructor(private readonly db: AircraftDb) {}

  async file(input: FileSquawkInput): Promise<SquawkWithPhotos> {
    if (!input.description?.trim()) {
      throw new SquawkValidationError("description is required");
    }
    if (!SQUAWK_SEVERITIES.includes(input.severity)) {
      throw new SquawkValidationError(
        `invalid severity: ${input.severity}`,
      );
    }
    const occurredAt = input.occurredAt ?? new Date();
    if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) {
      throw new SquawkValidationError("occurredAt must be a valid Date");
    }

    // The aircraft must exist for the tenant (defense-in-depth even with RLS).
    const ac = await this.db
      .select({ id: aircraft.id })
      .from(aircraft)
      .where(
        and(
          eq(aircraft.tenantId, input.tenantId),
          eq(aircraft.id, input.aircraftId),
        ),
      );
    if (!ac[0]) {
      throw new SquawkAircraftNotFoundError(`id=${input.aircraftId}`);
    }

    // Validate every photo before inserting the squawk row; this avoids an
    // orphan squawk if one of the document ids is bad. RLS would also hide
    // a cross-tenant document, but the explicit check produces a clearer
    // error.
    const photoIds = input.photoDocumentIds ?? [];
    if (photoIds.length > 0) {
      for (const docId of photoIds) {
        const docRows = await this.db
          .select({ id: documents.id, tenantId: documents.tenantId })
          .from(documents)
          .where(eq(documents.id, docId));
        const doc = docRows[0];
        if (!doc || doc.tenantId !== input.tenantId) {
          throw new SquawkPhotoCrossTenantError(docId, input.tenantId);
        }
      }
    }

    const [row] = await this.db
      .insert(squawks)
      .values({
        tenantId: input.tenantId,
        aircraftId: input.aircraftId,
        description: input.description.trim(),
        occurredAt,
        reporterUserId: input.reporterUserId ?? null,
        severity: input.severity,
      })
      .returning();
    if (!row) throw new Error("failed to insert squawk");

    const photos: SquawkPhoto[] = [];
    for (const documentId of photoIds) {
      const [photoRow] = await this.db
        .insert(squawkPhotos)
        .values({
          tenantId: input.tenantId,
          squawkId: row.id,
          documentId,
        })
        .returning();
      if (!photoRow) throw new Error("failed to insert squawk photo");
      photos.push(photoRow);
    }

    return { squawk: row, photos };
  }

  async getById(
    tenantId: string,
    squawkId: string,
  ): Promise<SquawkWithPhotos> {
    const rows = await this.db
      .select()
      .from(squawks)
      .where(
        and(eq(squawks.tenantId, tenantId), eq(squawks.id, squawkId)),
      );
    const row = rows[0];
    if (!row) throw new SquawkNotFoundError(`id=${squawkId}`);
    const photos = await this.db
      .select()
      .from(squawkPhotos)
      .where(
        and(
          eq(squawkPhotos.tenantId, tenantId),
          eq(squawkPhotos.squawkId, squawkId),
        ),
      );
    return { squawk: row, photos };
  }

  async listForAircraft(
    tenantId: string,
    aircraftId: string,
  ): Promise<Squawk[]> {
    return this.db
      .select()
      .from(squawks)
      .where(
        and(
          eq(squawks.tenantId, tenantId),
          eq(squawks.aircraftId, aircraftId),
        ),
      )
      .orderBy(desc(squawks.occurredAt), desc(squawks.createdAt));
  }

  /**
   * E1.3 helper: open grounding squawks for an aircraft. Used by the
   * compliance dashboard to flip the airworthiness indicator.
   */
  async listOpenGroundingForAircraft(
    tenantId: string,
    aircraftId: string,
  ): Promise<Squawk[]> {
    return this.db
      .select()
      .from(squawks)
      .where(
        and(
          eq(squawks.tenantId, tenantId),
          eq(squawks.aircraftId, aircraftId),
          eq(squawks.status, "open"),
          eq(squawks.severity, "grounding"),
        ),
      )
      .orderBy(desc(squawks.occurredAt));
  }

  /**
   * Mark a squawk resolved. Idempotent guard: a second resolve attempt
   * raises SquawkAlreadyResolvedError so a UI double-submit doesn't
   * silently overwrite the resolution narrative.
   */
  async resolve(input: ResolveSquawkInput): Promise<Squawk> {
    const existing = await this.getById(input.tenantId, input.squawkId);
    if (existing.squawk.status === "resolved") {
      throw new SquawkAlreadyResolvedError(input.squawkId);
    }
    const resolvedAt = input.resolvedAt ?? new Date();
    const [row] = await this.db
      .update(squawks)
      .set({
        status: "resolved",
        resolvedAt,
        resolvedByUserId: input.resolvedByUserId ?? null,
        resolutionNotes: input.resolutionNotes?.trim() || null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(squawks.tenantId, input.tenantId),
          eq(squawks.id, input.squawkId),
        ),
      )
      .returning();
    if (!row) throw new SquawkNotFoundError(`id=${input.squawkId}`);
    return row;
  }
}
