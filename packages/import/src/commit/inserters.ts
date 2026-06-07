import { schema as dbSchema } from "@ga/db";

import {
  findCredentialByCertificateNumber,
  findRtsTemplate,
  renderRtsBody,
} from "./resolve.js";
import type { ImportTx } from "./types.js";

const {
  aircraft,
  components,
  flightTimeEntries,
  maintenanceEntries,
} = dbSchema;

/**
 * Hard error from the inserter layer. The single-tx contract demands
 * we throw — never silently skip — so the outer commit transaction
 * rolls back and the job ends up `failed` with the cause captured.
 *
 * Distinct from {@link import("./types").ImportJobCommitFailedError}: this
 * type carries the row coordinates (sourceRowNumber) so the failure
 * summary can point at the offending row.
 */
export class RowInsertError extends Error {
  readonly code = "ROW_INSERT_FAILED" as const;
  constructor(
    readonly sourceRowNumber: number,
    readonly targetTable: string,
    readonly cause: unknown,
  ) {
    super(
      `row ${sourceRowNumber} into ${targetTable}: ${(cause as Error)?.message ?? cause}`,
    );
    this.name = "RowInsertError";
  }
}

interface InsertCtx {
  tx: ImportTx;
  tenantId: string;
  regimeId: string;
  importRowId: string;
  sourceRowNumber: number;
  mapped: Record<string, unknown>;
}

/**
 * Dispatch from target_table to the per-entity inserter. Returns the
 * live row id the staging row should point at via `committed_record_id`.
 */
export async function insertLiveRow(
  ctx: InsertCtx,
  targetTable: string,
): Promise<string> {
  try {
    switch (targetTable) {
      case "aircraft":
        return await insertAircraft(ctx);
      case "maintenance_entries":
        return await insertMaintenanceEntry(ctx);
      case "components":
        return await insertComponent(ctx);
      case "flight_time_entries":
        return await insertFlightTimeEntry(ctx);
      default:
        throw new Error(`unknown target_table: ${targetTable}`);
    }
  } catch (err) {
    if (err instanceof RowInsertError) throw err;
    throw new RowInsertError(ctx.sourceRowNumber, targetTable, err);
  }
}

async function insertAircraft(ctx: InsertCtx): Promise<string> {
  const m = ctx.mapped;
  const [row] = await ctx.tx
    .insert(aircraft)
    .values({
      tenantId: ctx.tenantId,
      // The mapping engine's `regime_by_code` lookup is the documented
      // path, but we fall back to the caller-supplied regimeId so a
      // mapping config without an explicit regime entry still works.
      regimeId: (m.regimeId as string) ?? ctx.regimeId,
      registration: m.registration as string,
      make: m.make as string,
      model: m.model as string,
      serialNumber: m.serialNumber as string,
      yearManufactured: (m.yearManufactured as number | null) ?? null,
      category: m.category as string,
      aircraftClass: m.aircraftClass as string,
      airframeTotalTime:
        m.airframeTotalTime !== undefined && m.airframeTotalTime !== null
          ? String(m.airframeTotalTime)
          : "0",
      timeSource: m.timeSource as "hobbs" | "tach",
      sourceImportRowId: ctx.importRowId,
    })
    .returning({ id: aircraft.id });
  return row!.id;
}

async function insertMaintenanceEntry(ctx: InsertCtx): Promise<string> {
  const m = ctx.mapped;

  // Resolve sign-off carriers (cert # → user/credential, rts code →
  // template id + body). The C4 validator already verified the codes
  // resolve at validation time; a miss at commit time is a hard error
  // because it means the catalog drifted between validate and commit.
  const certificateNumber = m.signedByCertificateNumber as string;
  const credential = await findCredentialByCertificateNumber(
    ctx.tx,
    certificateNumber,
  );
  if (!credential) {
    throw new Error(
      `signedByCertificateNumber '${certificateNumber}' no longer resolves to an active credential`,
    );
  }

  const rtsCode = m.rtsTemplateCode as string;
  const template = await findRtsTemplate(ctx.tx, ctx.regimeId, rtsCode);
  if (!template) {
    throw new Error(
      `rtsTemplateCode '${rtsCode}' no longer resolves in the regime RTS template catalog`,
    );
  }

  const workPerformed = m.workPerformed as string;
  const renderedBody = renderRtsBody(template.body, workPerformed);

  const [row] = await ctx.tx
    .insert(maintenanceEntries)
    .values({
      tenantId: ctx.tenantId,
      aircraftId: m.aircraftId as string,
      entryType: m.entryType as
        | "maintenance"
        | "annual_inspection"
        | "100_hour_inspection"
        | "inspection_program"
        | "ad_compliance",
      workPerformed,
      performedOn: m.performedOn as string,
      aircraftTotalTime: String(m.aircraftTotalTime),
      inspectionProgramId: (m.inspectionProgramId as string | null) ?? null,
      // Sign-off half — populated atomically with the pre-sign half
      // so the `signoff_shape` CHECK passes.
      signedAt: new Date(m.signedAt as string),
      signedByUserId: credential.userId,
      signedByCredentialId: credential.credentialId,
      signedByCertificateNumber: certificateNumber,
      rtsTemplateId: template.id,
      rtsRenderedBody: renderedBody,
      sourceImportRowId: ctx.importRowId,
    })
    .returning({ id: maintenanceEntries.id });
  return row!.id;
}

async function insertComponent(ctx: InsertCtx): Promise<string> {
  const m = ctx.mapped;
  const [row] = await ctx.tx
    .insert(components)
    .values({
      tenantId: ctx.tenantId,
      kind: m.kind as "engine" | "propeller" | "appliance",
      serialNumber: m.serialNumber as string,
      make: (m.make as string | null) ?? null,
      model: (m.model as string | null) ?? null,
      tboHours:
        m.tboHours !== undefined && m.tboHours !== null
          ? String(m.tboHours)
          : null,
      tboCalendarMonths: (m.tboCalendarMonths as number | null) ?? null,
      cycleLimit: (m.cycleLimit as number | null) ?? null,
      sourceImportRowId: ctx.importRowId,
    })
    .returning({ id: components.id });
  return row!.id;
}

async function insertFlightTimeEntry(ctx: InsertCtx): Promise<string> {
  const m = ctx.mapped;
  // The DB BEFORE INSERT trigger reads aircraft.airframe_total_time,
  // enforces monotonicity (unless is_override + override_reason), and
  // advances the aircraft's TT. Multiple rows for the same aircraft in
  // one tx stack correctly because the trigger reads the post-update
  // value within the same transaction.
  const [row] = await ctx.tx
    .insert(flightTimeEntries)
    .values({
      tenantId: ctx.tenantId,
      aircraftId: m.aircraftId as string,
      airframeTimeNew: String(m.airframeTimeNew),
      isOverride: (m.isOverride as boolean | undefined) ?? false,
      overrideReason: (m.overrideReason as string | null) ?? null,
      sourceImportRowId: ctx.importRowId,
    })
    .returning({ id: flightTimeEntries.id });
  return row!.id;
}
