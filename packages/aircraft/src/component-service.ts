import { and, desc, eq, isNull, sql } from "drizzle-orm";

import {
  type Component,
  type ComponentInstallation,
  type ComponentKind,
  COMPONENT_KINDS,
  schema as dbSchema,
} from "@ga/db";

import type { AircraftDb } from "./db.js";

const { aircraft, components, componentInstallations } = dbSchema;

export class ComponentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComponentValidationError";
  }
}

export class ComponentNotFoundError extends Error {
  constructor(criterion: string) {
    super(`component not found: ${criterion}`);
    this.name = "ComponentNotFoundError";
  }
}

export class AircraftNotFoundError extends Error {
  constructor(criterion: string) {
    super(`aircraft not found: ${criterion}`);
    this.name = "AircraftNotFoundError";
  }
}

export class ComponentAlreadyInstalledError extends Error {
  constructor(componentId: string) {
    super(`component ${componentId} already has an active installation`);
    this.name = "ComponentAlreadyInstalledError";
  }
}

export class ComponentNotInstalledError extends Error {
  constructor(componentId: string) {
    super(`component ${componentId} is not currently installed`);
    this.name = "ComponentNotInstalledError";
  }
}

export interface CreateComponentInput {
  tenantId: string;
  kind: ComponentKind;
  serialNumber: string;
  make?: string | null;
  model?: string | null;
  tboHours?: number | null;
  tboCalendarMonths?: number | null;
  cycleLimit?: number | null;
}

export interface InstallComponentInput {
  tenantId: string;
  componentId: string;
  aircraftId: string;
  installedAt: Date;
  notes?: string | null;
  /**
   * Optional override of the airframe TT at install. Defaults to the
   * aircraft's current `airframeTotalTime` — the right answer in the
   * happy path; the override exists so a historical backfill can pin a
   * past value.
   */
  installedAtAircraftTotalTime?: number;
}

export interface RemoveComponentInput {
  tenantId: string;
  componentId: string;
  removedAt: Date;
  notes?: string | null;
  /**
   * Optional override of the airframe TT at removal. Defaults to the
   * aircraft's current `airframeTotalTime`.
   */
  removedAtAircraftTotalTime?: number;
}

export interface ComponentWithActiveInstallation {
  component: Component;
  activeInstallation: ComponentInstallation | null;
}

/**
 * Domain service for B2 — components + install/remove flow. As with
 * AircraftService, tenant scoping is the caller's job (wrap in
 * `runAsTenant`). The service still passes `tenantId` to every query
 * for defense-in-depth.
 */
export class ComponentService {
  constructor(private readonly db: AircraftDb) {}

  async create(input: CreateComponentInput): Promise<Component> {
    if (!COMPONENT_KINDS.includes(input.kind)) {
      throw new ComponentValidationError(`invalid kind: ${input.kind}`);
    }
    if (!input.serialNumber.trim()) {
      throw new ComponentValidationError("serialNumber is required");
    }
    const positives: [string, number | null | undefined][] = [
      ["tboHours", input.tboHours],
      ["tboCalendarMonths", input.tboCalendarMonths],
      ["cycleLimit", input.cycleLimit],
    ];
    for (const [name, value] of positives) {
      if (value !== undefined && value !== null && value <= 0) {
        throw new ComponentValidationError(`${name} must be > 0 when set`);
      }
    }

    const [row] = await this.db
      .insert(components)
      .values({
        tenantId: input.tenantId,
        kind: input.kind,
        serialNumber: input.serialNumber.trim(),
        make: input.make ?? null,
        model: input.model ?? null,
        tboHours: input.tboHours != null ? String(input.tboHours) : null,
        tboCalendarMonths: input.tboCalendarMonths ?? null,
        cycleLimit: input.cycleLimit ?? null,
      })
      .returning();
    if (!row) throw new Error("failed to insert component");
    return row;
  }

  async getById(tenantId: string, componentId: string): Promise<Component> {
    const rows = await this.db
      .select()
      .from(components)
      .where(
        and(eq(components.tenantId, tenantId), eq(components.id, componentId)),
      );
    const row = rows[0];
    if (!row) throw new ComponentNotFoundError(`id=${componentId}`);
    return row;
  }

  async listForTenant(tenantId: string): Promise<Component[]> {
    return this.db
      .select()
      .from(components)
      .where(eq(components.tenantId, tenantId));
  }

  async listHistory(
    tenantId: string,
    componentId: string,
  ): Promise<ComponentInstallation[]> {
    return this.db
      .select()
      .from(componentInstallations)
      .where(
        and(
          eq(componentInstallations.tenantId, tenantId),
          eq(componentInstallations.componentId, componentId),
        ),
      )
      .orderBy(desc(componentInstallations.installedAt));
  }

  async getActiveInstallation(
    tenantId: string,
    componentId: string,
  ): Promise<ComponentInstallation | null> {
    const rows = await this.db
      .select()
      .from(componentInstallations)
      .where(
        and(
          eq(componentInstallations.tenantId, tenantId),
          eq(componentInstallations.componentId, componentId),
          isNull(componentInstallations.removedAt),
        ),
      );
    return rows[0] ?? null;
  }

  /**
   * List currently-installed components on an aircraft, with the
   * installation row attached. Used by the aircraft profile (B1.2).
   */
  async listInstalledOnAircraft(
    tenantId: string,
    aircraftId: string,
  ): Promise<{ component: Component; installation: ComponentInstallation }[]> {
    const rows = await this.db
      .select({
        component: components,
        installation: componentInstallations,
      })
      .from(componentInstallations)
      .innerJoin(
        components,
        eq(componentInstallations.componentId, components.id),
      )
      .where(
        and(
          eq(componentInstallations.tenantId, tenantId),
          eq(componentInstallations.aircraftId, aircraftId),
          isNull(componentInstallations.removedAt),
        ),
      );
    return rows;
  }

  async install(input: InstallComponentInput): Promise<ComponentInstallation> {
    const component = await this.getById(input.tenantId, input.componentId);

    const aircraftRows = await this.db
      .select()
      .from(aircraft)
      .where(
        and(
          eq(aircraft.tenantId, input.tenantId),
          eq(aircraft.id, input.aircraftId),
        ),
      );
    const aircraftRow = aircraftRows[0];
    if (!aircraftRow) {
      throw new AircraftNotFoundError(`id=${input.aircraftId}`);
    }

    const existing = await this.getActiveInstallation(
      input.tenantId,
      component.id,
    );
    if (existing) {
      throw new ComponentAlreadyInstalledError(component.id);
    }

    const installTt =
      input.installedAtAircraftTotalTime !== undefined
        ? input.installedAtAircraftTotalTime
        : Number(aircraftRow.airframeTotalTime);

    if (installTt < 0) {
      throw new ComponentValidationError(
        "installedAtAircraftTotalTime must be >= 0",
      );
    }

    const [row] = await this.db
      .insert(componentInstallations)
      .values({
        tenantId: input.tenantId,
        componentId: component.id,
        aircraftId: aircraftRow.id,
        installedAt: input.installedAt,
        installedAtAircraftTotalTime: String(installTt),
        notes: input.notes ?? null,
      })
      .returning();
    if (!row) throw new Error("failed to insert installation");
    return row;
  }

  async remove(input: RemoveComponentInput): Promise<ComponentInstallation> {
    const active = await this.getActiveInstallation(
      input.tenantId,
      input.componentId,
    );
    if (!active) {
      throw new ComponentNotInstalledError(input.componentId);
    }

    if (input.removedAt < active.installedAt) {
      throw new ComponentValidationError(
        "removedAt must be on or after installedAt",
      );
    }

    const aircraftRows = await this.db
      .select()
      .from(aircraft)
      .where(
        and(
          eq(aircraft.tenantId, input.tenantId),
          eq(aircraft.id, active.aircraftId),
        ),
      );
    const aircraftRow = aircraftRows[0];
    if (!aircraftRow) {
      throw new AircraftNotFoundError(`id=${active.aircraftId}`);
    }

    const removeTt =
      input.removedAtAircraftTotalTime !== undefined
        ? input.removedAtAircraftTotalTime
        : Number(aircraftRow.airframeTotalTime);

    if (removeTt < Number(active.installedAtAircraftTotalTime)) {
      throw new ComponentValidationError(
        "removedAtAircraftTotalTime must be >= installedAtAircraftTotalTime",
      );
    }

    const [row] = await this.db
      .update(componentInstallations)
      .set({
        removedAt: input.removedAt,
        removedAtAircraftTotalTime: String(removeTt),
        notes: input.notes ?? active.notes ?? null,
      })
      .where(eq(componentInstallations.id, active.id))
      .returning();
    if (!row) throw new Error("failed to update installation");
    return row;
  }
}
