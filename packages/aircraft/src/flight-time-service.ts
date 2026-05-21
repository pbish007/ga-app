import { and, desc, eq } from "drizzle-orm";

import { type FlightTimeEntry, schema as dbSchema } from "@ga/db";

import type { AircraftDb } from "./db.js";

const { flightTimeEntries } = dbSchema;

export class FlightTimeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlightTimeValidationError";
  }
}

export class FlightTimeMonotonicError extends Error {
  constructor(
    public readonly newReading: number,
    public readonly currentTt: number,
  ) {
    super(
      `new reading (${newReading}) is less than current airframe total time (${currentTt})`,
    );
    this.name = "FlightTimeMonotonicError";
  }
}

export interface LogFlightTimeInput {
  tenantId: string;
  aircraftId: string;
  airframeTimeNew: number;
  /** When true, bypass monotonicity and record an instrument-swap override. */
  isOverride?: boolean;
  /** Required when isOverride=true. */
  overrideReason?: string;
  /** Id of the user performing the entry, for the audit trail. */
  enteredByUserId?: string;
}

/**
 * Domain service for manual flight-time entries (Epic C / C1).
 *
 * Monotonicity is enforced at both layers:
 *  - App layer: FlightTimeMonotonicError on non-override regressions.
 *  - DB layer: BEFORE INSERT trigger raises flight_time_not_monotonic.
 *
 * Atomicity: `aircraft.airframe_total_time` is advanced by the trigger
 * inside the same INSERT statement, so a single transaction covers both.
 */
export class FlightTimeService {
  constructor(private readonly db: AircraftDb) {}

  async logFlightTime(input: LogFlightTimeInput): Promise<FlightTimeEntry> {
    if (!Number.isFinite(input.airframeTimeNew) || input.airframeTimeNew < 0) {
      throw new FlightTimeValidationError(
        "airframeTimeNew must be a non-negative finite number",
      );
    }
    if (input.isOverride && !input.overrideReason?.trim()) {
      throw new FlightTimeValidationError(
        "overrideReason is required when isOverride is true",
      );
    }

    try {
      const [row] = await this.db
        .insert(flightTimeEntries)
        .values({
          tenantId: input.tenantId,
          aircraftId: input.aircraftId,
          airframeTimeNew: String(input.airframeTimeNew),
          isOverride: input.isOverride ?? false,
          overrideReason: input.overrideReason ?? null,
          enteredByUserId: input.enteredByUserId ?? null,
        })
        .returning();
      if (!row) throw new Error("insert returned no rows");
      return row;
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes("flight_time_not_monotonic")
      ) {
        const match = err.message.match(
          /new reading \(([^)]+)\).*current airframe total time \(([^)]+)\)/,
        );
        const newVal = match ? Number(match[1]) : input.airframeTimeNew;
        const curVal = match ? Number(match[2]) : 0;
        throw new FlightTimeMonotonicError(newVal, curVal);
      }
      throw err;
    }
  }

  async listForAircraft(
    tenantId: string,
    aircraftId: string,
    limit = 50,
  ): Promise<FlightTimeEntry[]> {
    return this.db
      .select()
      .from(flightTimeEntries)
      .where(
        and(
          eq(flightTimeEntries.tenantId, tenantId),
          eq(flightTimeEntries.aircraftId, aircraftId),
        ),
      )
      .orderBy(desc(flightTimeEntries.enteredAt))
      .limit(limit);
  }
}
