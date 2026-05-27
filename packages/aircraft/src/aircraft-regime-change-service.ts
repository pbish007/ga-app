import { and, desc, eq, sql } from "drizzle-orm";

import {
  type Aircraft,
  type AircraftRegimeChange,
  type RegimeRetentionRule,
  schema as dbSchema,
} from "@ga/db";

import type { AircraftDb } from "./db.js";

const { aircraft, aircraftRegimeChanges, regimeRetentionRules } = dbSchema;

const REGIME_CHANGE_RECORD_KIND = "regime_change";

export class AircraftRegimeChangeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AircraftRegimeChangeValidationError";
  }
}

export class AircraftRegimeChangeAircraftNotFoundError extends Error {
  constructor(criterion: string) {
    super(`aircraft not found: ${criterion}`);
    this.name = "AircraftRegimeChangeAircraftNotFoundError";
  }
}

export class AircraftRegimeChangeRegimeNotFoundError extends Error {
  constructor(regimeId: string) {
    super(`regime not found: ${regimeId}`);
    this.name = "AircraftRegimeChangeRegimeNotFoundError";
  }
}

export interface ChangeRegimeInput {
  tenantId: string;
  aircraftId: string;
  toRegimeId: string;
  actorUserId: string;
  reason: string;
}

export interface ChangeRegimeResult {
  aircraft: Aircraft;
  change: AircraftRegimeChange;
}

/**
 * K2.2 — restricted, audited regime change for an aircraft (PMB-18).
 *
 * The service performs the read-current-update-insert sequence as a
 * single transaction so the audit row is durable iff the aircraft
 * write committed. Authorisation is the caller's job — the web layer
 * gates `aircraft.change_regime` (Admin only) via `withRequest`; this
 * service refuses to write under any other circumstance only by
 * validating its own inputs (tenant id, distinct regimes, nonempty
 * reason).
 */
export class AircraftRegimeChangeService {
  constructor(private readonly db: AircraftDb) {}

  async change(input: ChangeRegimeInput): Promise<ChangeRegimeResult> {
    const reason = input.reason.trim();
    if (!reason) {
      throw new AircraftRegimeChangeValidationError("reason is required");
    }
    if (!input.toRegimeId) {
      throw new AircraftRegimeChangeValidationError(
        "toRegimeId is required",
      );
    }
    if (!input.actorUserId) {
      throw new AircraftRegimeChangeValidationError(
        "actorUserId is required",
      );
    }

    try {
      return await this.db.transaction(async (tx) => {
        const current = await tx
          .select()
          .from(aircraft)
          .where(
            and(
              eq(aircraft.tenantId, input.tenantId),
              eq(aircraft.id, input.aircraftId),
            ),
          )
          .limit(1);
        const row = current[0];
        if (!row) {
          throw new AircraftRegimeChangeAircraftNotFoundError(
            `id=${input.aircraftId}`,
          );
        }
        if (row.regimeId === input.toRegimeId) {
          throw new AircraftRegimeChangeValidationError(
            "toRegimeId matches the aircraft's current regime; nothing to do",
          );
        }

        const [updated] = await tx
          .update(aircraft)
          .set({ regimeId: input.toRegimeId, updatedAt: sql`now()` })
          .where(
            and(
              eq(aircraft.tenantId, input.tenantId),
              eq(aircraft.id, input.aircraftId),
            ),
          )
          .returning();
        if (!updated) {
          throw new AircraftRegimeChangeAircraftNotFoundError(
            `id=${input.aircraftId}`,
          );
        }

        const [inserted] = await tx
          .insert(aircraftRegimeChanges)
          .values({
            tenantId: input.tenantId,
            aircraftId: input.aircraftId,
            fromRegimeId: row.regimeId,
            toRegimeId: input.toRegimeId,
            actorUserId: input.actorUserId,
            reason,
          })
          .returning();

        return { aircraft: updated, change: inserted! };
      });
    } catch (err) {
      // Postgres FK violations on either the aircraft.regime_id update
      // or the audit row insert mean the target regime is unknown.
      // Both surface as "violates foreign key constraint ... regime"
      // — translate to a domain error so callers can render a 404/400.
      if (
        err instanceof Error &&
        /foreign key|violates/i.test(err.message) &&
        /regime/i.test(err.message)
      ) {
        throw new AircraftRegimeChangeRegimeNotFoundError(input.toRegimeId);
      }
      throw err;
    }
  }

  /**
   * Operator-visible history for an aircraft. Newest first.
   * Returns an empty array if the aircraft has no recorded regime
   * changes (i.e. it has stayed on its birth regime).
   */
  async listForAircraft(
    tenantId: string,
    aircraftId: string,
  ): Promise<AircraftRegimeChange[]> {
    return this.db
      .select()
      .from(aircraftRegimeChanges)
      .where(
        and(
          eq(aircraftRegimeChanges.tenantId, tenantId),
          eq(aircraftRegimeChanges.aircraftId, aircraftId),
        ),
      )
      .orderBy(desc(aircraftRegimeChanges.createdAt));
  }

  /**
   * J4 hook — retention rule for `regime_change` records under a given
   * regime. Returns null if the regime has not seeded the rule (the
   * 0015 migration seeds it for FAA; new regimes must ship their own).
   * App code reading retention MUST use this, not a literal.
   */
  async retentionRuleFor(
    regimeId: string,
  ): Promise<RegimeRetentionRule | null> {
    const rows = await this.db
      .select()
      .from(regimeRetentionRules)
      .where(
        and(
          eq(regimeRetentionRules.regimeId, regimeId),
          eq(regimeRetentionRules.recordKind, REGIME_CHANGE_RECORD_KIND),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
}

export const REGIME_CHANGE_RETENTION_RECORD_KIND = REGIME_CHANGE_RECORD_KIND;
