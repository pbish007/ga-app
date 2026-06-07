import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";

import {
  FAA_FIELD_DECISIONS,
  FAA_FIELD_KEYS,
  FAA_FIELD_REPORT_REASONS,
  schema as dbSchema,
  type AircraftFaaFieldDecision,
  type FaaFieldDecision,
  type FaaFieldKey,
  type FaaFieldReportReason,
} from "@ga/db";

import type { AircraftDb } from "./db.js";

const { aircraft, aircraftFaaFieldDecisions } = dbSchema;

export class AircraftFaaDecisionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AircraftFaaDecisionValidationError";
  }
}

export class AircraftFaaDecisionAircraftNotFoundError extends Error {
  constructor(aircraftId: string) {
    super(`aircraft not found: ${aircraftId}`);
    this.name = "AircraftFaaDecisionAircraftNotFoundError";
  }
}

export interface RecordFaaFieldDecisionInput {
  tenantId: string;
  aircraftId: string;
  fieldKey: FaaFieldKey;
  decision: FaaFieldDecision;
  /**
   * The FAA Registry value that was offered to the user at decision
   * time. Can be null when decision is `tenant_wins` over a now-empty
   * FAA field — but the caller must still supply the hash so the
   * sync-side anti-nag oracle has something to compare against.
   */
  faaValue: string | null;
  tenantValue: string | null;
  reportReason?: FaaFieldReportReason | null;
  reportNote?: string | null;
  decidedByUserId: string;
}

/**
 * Domain service for the per-field FAA prefill decision log (PMB-109).
 *
 * Storage shape: one row per (aircraft, field_key) holding the latest
 * decision. Older decisions are overwritten in place by the UPSERT —
 * the audit shape we keep is the latest user intent, not a history of
 * dismissed values. (Spec §3.4 audit posture is satisfied by the
 * `decided_by_user_id` + `decided_at` + the `faa_value_hash` pin.)
 *
 * Tenant scoping is the caller's job — wrap calls in `runAsTenant` so
 * RLS enforces isolation at the database. The service still passes
 * `tenant_id` on inserts (RLS WITH CHECK requires it) and asserts the
 * aircraft belongs to the same tenant before writing.
 */
export class AircraftFaaDecisionService {
  constructor(private readonly db: AircraftDb) {}

  /**
   * Record (or overwrite) a per-field decision. The hash is computed
   * here from the supplied FAA value so callers cannot accidentally
   * pin to a different bytes-vs-string normalization than the sync
   * pipeline. Caller-provided hashes were considered and rejected —
   * the single hashing point is the simpler audit story.
   */
  async record(input: RecordFaaFieldDecisionInput): Promise<AircraftFaaFieldDecision> {
    validate(input);

    const aircraftRow = await this.db
      .select({
        id: aircraft.id,
        tenantId: aircraft.tenantId,
        registration: aircraft.registration,
      })
      .from(aircraft)
      .where(
        and(
          eq(aircraft.id, input.aircraftId),
          eq(aircraft.tenantId, input.tenantId),
        ),
      )
      .limit(1);

    if (aircraftRow.length === 0) {
      throw new AircraftFaaDecisionAircraftNotFoundError(input.aircraftId);
    }

    const faaValueHash = sha256Hex(input.faaValue);
    const nNumber = normalizeNNumber(aircraftRow[0]!.registration);

    const reportReason =
      input.decision === "faa_reported_wrong" ? input.reportReason ?? null : null;
    const reportNote =
      input.decision === "faa_reported_wrong" ? input.reportNote ?? null : null;

    const rows = await this.db
      .insert(aircraftFaaFieldDecisions)
      .values({
        tenantId: input.tenantId,
        aircraftId: input.aircraftId,
        nNumber,
        fieldKey: input.fieldKey,
        decision: input.decision,
        faaValue: input.faaValue,
        faaValueHash,
        tenantValue: input.tenantValue,
        reportReason,
        reportNote,
        decidedByUserId: input.decidedByUserId,
      })
      .onConflictDoUpdate({
        target: [
          aircraftFaaFieldDecisions.aircraftId,
          aircraftFaaFieldDecisions.fieldKey,
        ],
        set: {
          decision: input.decision,
          faaValue: input.faaValue,
          faaValueHash,
          tenantValue: input.tenantValue,
          reportReason,
          reportNote,
          decidedByUserId: input.decidedByUserId,
          decidedAt: new Date(),
        },
      })
      .returning();

    return rows[0]!;
  }

  async listByAircraft(
    tenantId: string,
    aircraftId: string,
  ): Promise<AircraftFaaFieldDecision[]> {
    return this.db
      .select()
      .from(aircraftFaaFieldDecisions)
      .where(
        and(
          eq(aircraftFaaFieldDecisions.tenantId, tenantId),
          eq(aircraftFaaFieldDecisions.aircraftId, aircraftId),
        ),
      );
  }
}

/**
 * sha256-hex with a stable representation for NULL FAA values. The
 * empty-string sentinel keeps the column NOT NULL while still letting
 * a sync-side compare detect "FAA went from value X to no value at
 * all" as a real change.
 */
function sha256Hex(value: string | null): string {
  const input = value ?? "";
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Canonicalize an N-number for storage on the decision row. The FAA
 * registry stores tail numbers uppercase, no leading 'N'. The tenant
 * `aircraft.registration` field is operator-typed and may include
 * `N`, lowercase, or whitespace. We normalize to FAA shape so the
 * pipeline-side sync can match by string equality.
 */
function normalizeNNumber(registration: string): string {
  const trimmed = registration.trim().toUpperCase();
  return trimmed.startsWith("N") ? trimmed.slice(1) : trimmed;
}

function validate(input: RecordFaaFieldDecisionInput): void {
  if (!FAA_FIELD_KEYS.includes(input.fieldKey)) {
    throw new AircraftFaaDecisionValidationError(
      `unknown field_key: ${input.fieldKey}`,
    );
  }
  if (!FAA_FIELD_DECISIONS.includes(input.decision)) {
    throw new AircraftFaaDecisionValidationError(
      `unknown decision: ${input.decision}`,
    );
  }
  if (input.decision === "faa_reported_wrong") {
    const reason = input.reportReason;
    if (!reason || !FAA_FIELD_REPORT_REASONS.includes(reason)) {
      throw new AircraftFaaDecisionValidationError(
        "report_reason is required when decision is faa_reported_wrong",
      );
    }
    if (input.reportNote != null && input.reportNote.length > 280) {
      throw new AircraftFaaDecisionValidationError(
        "report_note exceeds 280 characters",
      );
    }
  } else {
    if (input.reportReason != null || input.reportNote != null) {
      throw new AircraftFaaDecisionValidationError(
        "report_reason / report_note are only allowed when decision is faa_reported_wrong",
      );
    }
  }
}

export { normalizeNNumber, sha256Hex };
