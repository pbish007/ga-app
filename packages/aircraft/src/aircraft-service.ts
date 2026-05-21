import { and, eq, sql } from "drizzle-orm";

import {
  AIRCRAFT_TIME_SOURCES,
  type Aircraft,
  type AircraftTimeSource,
  schema as dbSchema,
} from "@ga/db";
import { DEFAULT_REGIME_CODE, RegimeClient } from "@ga/regime";

import type { AircraftDb } from "./db.js";

const { aircraft } = dbSchema;

export class AircraftValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AircraftValidationError";
  }
}

export class AircraftNotFoundError extends Error {
  constructor(criterion: string) {
    super(`aircraft not found: ${criterion}`);
    this.name = "AircraftNotFoundError";
  }
}

export interface CreateAircraftInput {
  tenantId: string;
  registration: string;
  make: string;
  model: string;
  serialNumber: string;
  category: string;
  aircraftClass: string;
  timeSource: AircraftTimeSource;
  yearManufactured?: number | null;
  airframeTotalTime?: number;
  /**
   * Optional override. Defaults to the tenant-platform default regime
   * (FAA today). The K2 seam: app code never bakes "FAA" in — it asks
   * the regime client.
   */
  regimeId?: string;
}

export interface UpdateAirframeTotalTimeInput {
  tenantId: string;
  aircraftId: string;
  airframeTotalTime: number;
}

/**
 * Domain service for aircraft profiles (B1). Tenant scoping is the
 * caller's job — wrap calls in `runAsTenant` (or attach a tenant-bound
 * connection) so RLS enforces isolation at the database, not the app.
 */
export class AircraftService {
  private readonly regimeClient: RegimeClient;

  constructor(private readonly db: AircraftDb) {
    this.regimeClient = new RegimeClient(db);
  }

  async create(input: CreateAircraftInput): Promise<Aircraft> {
    if (!AIRCRAFT_TIME_SOURCES.includes(input.timeSource)) {
      throw new AircraftValidationError(
        `invalid timeSource: ${input.timeSource}`,
      );
    }
    if (input.airframeTotalTime !== undefined && input.airframeTotalTime < 0) {
      throw new AircraftValidationError("airframeTotalTime must be >= 0");
    }
    if (!input.registration.trim()) {
      throw new AircraftValidationError("registration is required");
    }

    const regimeId =
      input.regimeId ??
      (await this.regimeClient.getByCode(DEFAULT_REGIME_CODE)).id;

    const [row] = await this.db
      .insert(aircraft)
      .values({
        tenantId: input.tenantId,
        regimeId,
        registration: input.registration.trim(),
        make: input.make,
        model: input.model,
        serialNumber: input.serialNumber,
        yearManufactured: input.yearManufactured ?? null,
        category: input.category,
        aircraftClass: input.aircraftClass,
        airframeTotalTime:
          input.airframeTotalTime !== undefined
            ? String(input.airframeTotalTime)
            : "0",
        timeSource: input.timeSource,
      })
      .returning();
    if (!row) throw new Error("failed to insert aircraft");
    return row;
  }

  async getById(tenantId: string, aircraftId: string): Promise<Aircraft> {
    const rows = await this.db
      .select()
      .from(aircraft)
      .where(and(eq(aircraft.tenantId, tenantId), eq(aircraft.id, aircraftId)));
    const row = rows[0];
    if (!row) throw new AircraftNotFoundError(`id=${aircraftId}`);
    return row;
  }

  async listForTenant(tenantId: string): Promise<Aircraft[]> {
    return this.db
      .select()
      .from(aircraft)
      .where(eq(aircraft.tenantId, tenantId));
  }

  /**
   * Advance airframe TT. Used by Epic C (time entry) when a flight is
   * logged; surfaced here for B1's edit-profile flow as well.
   */
  async updateAirframeTotalTime(
    input: UpdateAirframeTotalTimeInput,
  ): Promise<Aircraft> {
    if (input.airframeTotalTime < 0) {
      throw new AircraftValidationError("airframeTotalTime must be >= 0");
    }
    const [row] = await this.db
      .update(aircraft)
      .set({
        airframeTotalTime: String(input.airframeTotalTime),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(aircraft.tenantId, input.tenantId),
          eq(aircraft.id, input.aircraftId),
        ),
      )
      .returning();
    if (!row) throw new AircraftNotFoundError(`id=${input.aircraftId}`);
    return row;
  }
}
