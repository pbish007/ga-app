import { and, desc, eq, isNull } from "drizzle-orm";

import {
  MAINTENANCE_ENTRY_TYPES,
  type MaintenanceEntry,
  type MaintenanceEntryType,
  schema as dbSchema,
} from "@ga/db";

import type { AircraftDb } from "./db.js";

const {
  maintenanceEntries,
  aircraft,
  users,
  userCredentials,
  regimeCredentialTypes,
  regimeRtsTemplates,
} = dbSchema;

export class MaintenanceEntryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaintenanceEntryValidationError";
  }
}

export class MaintenanceEntryNotFoundError extends Error {
  constructor(criterion: string) {
    super(`maintenance entry not found: ${criterion}`);
    this.name = "MaintenanceEntryNotFoundError";
  }
}

export class MaintenanceEntryAircraftNotFoundError extends Error {
  constructor(criterion: string) {
    super(`aircraft not found: ${criterion}`);
    this.name = "MaintenanceEntryAircraftNotFoundError";
  }
}

export class MaintenanceEntryAlreadySignedError extends Error {
  constructor(entryId: string) {
    super(`maintenance entry ${entryId} is already signed and immutable`);
    this.name = "MaintenanceEntryAlreadySignedError";
  }
}

/**
 * Sign-off rejected because the user does not hold a credential under
 * the aircraft's regime whose type sets `authorizes_signoff = true`.
 * The check is identical to A2.3 `CredentialService.canSignOff`, but
 * the F1.2 path runs it inline because it also needs the credential
 * row's id and certificate_number for the snapshot.
 */
export class MaintenanceEntryNotAuthorizedToSignError extends Error {
  constructor(userId: string) {
    super(
      `user ${userId} does not hold a sign-off-authorising credential under this aircraft's regime`,
    );
    this.name = "MaintenanceEntryNotAuthorizedToSignError";
  }
}

export class MaintenanceEntryTemplateNotFoundError extends Error {
  constructor(criterion: string) {
    super(`RTS template not found: ${criterion}`);
    this.name = "MaintenanceEntryTemplateNotFoundError";
  }
}

export interface DraftMaintenanceEntryInput {
  tenantId: string;
  aircraftId: string;
  entryType: MaintenanceEntryType;
  workPerformed: string;
  /** ISO-8601 date (YYYY-MM-DD). */
  performedOn: string;
  /** Airframe total time at the moment the work was performed. */
  aircraftTotalTime: number | string;
  /** Optional inspection program this entry pertains to. */
  inspectionProgramId?: string | null;
  /** If this is a correction, the id of the prior entry it amends. */
  correctionOfId?: string | null;
}

export interface SignMaintenanceEntryInput {
  tenantId: string;
  entryId: string;
  /** The user whose credential authorizes the sign-off. */
  signedByUserId: string;
  /**
   * Override the "now" clock — used by tests to exercise the expiry
   * edge in the credential gate.
   */
  now?: Date;
  /**
   * Override the RTS template selected. If omitted the service picks
   * the template by entry_type via `recommendRtsTemplateCode`.
   */
  rtsTemplateCode?: string;
}

/**
 * F2 mapping from entry type to default RTS template code.
 *
 * NOTE: This is structural mapping (which template to use for which
 * action), NOT regulatory wording. The wording itself lives in
 * `regime_rts_templates.body`. Adding a regime means adding template
 * rows whose codes match this set — no code change required.
 *
 * Keeping the map here keeps the F2.3 lint test honest: it grep-bans
 * regulatory text, not the structural mapping below.
 */
export function recommendRtsTemplateCode(
  entryType: MaintenanceEntryType,
): string {
  switch (entryType) {
    case "annual_inspection":
      return "annual";
    case "100_hour_inspection":
      return "100_hour";
    case "ad_compliance":
      return "ad_compliance";
    case "inspection_program":
      return "standard";
    case "maintenance":
    default:
      return "return_to_service_maintenance";
  }
}

/**
 * Render an RTS template body by substituting the supported
 * placeholders. The placeholders are STRUCTURAL ({{name}}-style); the
 * regulatory text around them comes from the template row.
 *
 * Supported placeholders:
 *   {{work_performed}}           — the entry's work_performed text.
 *   {{inspection_program_name}}  — the name of the linked inspection
 *                                  program template, or "" if none.
 *   {{aircraft_total_time}}      — airframe time at the entry.
 *   {{performed_on}}             — the entry's performed_on date.
 *   {{aircraft_registration}}    — the aircraft registration (tail #).
 *   {{certificate_number}}       — the mechanic's certificate number,
 *                                  or "" if absent.
 */
export function renderRtsTemplate(
  templateBody: string,
  context: {
    workPerformed: string;
    inspectionProgramName?: string | null;
    aircraftTotalTime: string | number;
    performedOn: string;
    aircraftRegistration: string;
    certificateNumber?: string | null;
  },
): string {
  return templateBody
    .replaceAll("{{work_performed}}", context.workPerformed)
    .replaceAll(
      "{{inspection_program_name}}",
      context.inspectionProgramName ?? "",
    )
    .replaceAll(
      "{{aircraft_total_time}}",
      String(context.aircraftTotalTime),
    )
    .replaceAll("{{performed_on}}", context.performedOn)
    .replaceAll(
      "{{aircraft_registration}}",
      context.aircraftRegistration,
    )
    .replaceAll(
      "{{certificate_number}}",
      context.certificateNumber ?? "",
    );
}

/**
 * Domain service for F1 (maintenance entries) and F2 (RTS sign-off).
 *
 * Pre-sign entries are mutable drafts. Once signed, the DB trigger
 * `maintenance_entries_block_signed_update` enforces immutability —
 * the service layer also refuses pre-sign updates of a signed row
 * with a clear error so the UI/API can render a useful message
 * before the DB exception fires.
 *
 * Corrections are NEW rows — never in-place updates. Callers create a
 * follow-up via `draft({ ..., correctionOfId })` and then sign it.
 */
export class MaintenanceEntryService {
  constructor(private readonly db: AircraftDb) {}

  async draft(
    input: DraftMaintenanceEntryInput,
  ): Promise<MaintenanceEntry> {
    if (!input.workPerformed?.trim()) {
      throw new MaintenanceEntryValidationError("workPerformed is required");
    }
    if (!MAINTENANCE_ENTRY_TYPES.includes(input.entryType)) {
      throw new MaintenanceEntryValidationError(
        `invalid entryType: ${input.entryType}`,
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.performedOn)) {
      throw new MaintenanceEntryValidationError(
        "performedOn must be ISO-8601 date (YYYY-MM-DD)",
      );
    }
    const airframe =
      typeof input.aircraftTotalTime === "number"
        ? input.aircraftTotalTime
        : Number(input.aircraftTotalTime);
    if (!Number.isFinite(airframe) || airframe < 0) {
      throw new MaintenanceEntryValidationError(
        "aircraftTotalTime must be a non-negative number",
      );
    }

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
      throw new MaintenanceEntryAircraftNotFoundError(
        `id=${input.aircraftId}`,
      );
    }

    if (input.correctionOfId) {
      const prior = await this.db
        .select({ id: maintenanceEntries.id, signedAt: maintenanceEntries.signedAt })
        .from(maintenanceEntries)
        .where(
          and(
            eq(maintenanceEntries.tenantId, input.tenantId),
            eq(maintenanceEntries.id, input.correctionOfId),
          ),
        );
      if (!prior[0]) {
        throw new MaintenanceEntryNotFoundError(
          `correctionOfId=${input.correctionOfId}`,
        );
      }
      if (!prior[0].signedAt) {
        throw new MaintenanceEntryValidationError(
          "cannot correct an unsigned entry — edit the draft instead",
        );
      }
    }

    const [row] = await this.db
      .insert(maintenanceEntries)
      .values({
        tenantId: input.tenantId,
        aircraftId: input.aircraftId,
        entryType: input.entryType,
        workPerformed: input.workPerformed.trim(),
        performedOn: input.performedOn,
        aircraftTotalTime: String(airframe),
        inspectionProgramId: input.inspectionProgramId ?? null,
        correctionOfId: input.correctionOfId ?? null,
      })
      .returning();
    if (!row) throw new Error("failed to insert maintenance entry");
    return row;
  }

  async getById(
    tenantId: string,
    entryId: string,
  ): Promise<MaintenanceEntry> {
    const rows = await this.db
      .select()
      .from(maintenanceEntries)
      .where(
        and(
          eq(maintenanceEntries.tenantId, tenantId),
          eq(maintenanceEntries.id, entryId),
        ),
      );
    const row = rows[0];
    if (!row) throw new MaintenanceEntryNotFoundError(`id=${entryId}`);
    return row;
  }

  async listForAircraft(
    tenantId: string,
    aircraftId: string,
  ): Promise<MaintenanceEntry[]> {
    return this.db
      .select()
      .from(maintenanceEntries)
      .where(
        and(
          eq(maintenanceEntries.tenantId, tenantId),
          eq(maintenanceEntries.aircraftId, aircraftId),
        ),
      )
      .orderBy(
        desc(maintenanceEntries.performedOn),
        desc(maintenanceEntries.createdAt),
      );
  }

  /**
   * F1.2 sign-off flow. Atomically:
   *   1. Verifies the user holds a credential under the aircraft's
   *      regime whose type authorises sign-off, is not revoked, and
   *      is not expired. (A2.3 credential gate.)
   *   2. Selects an RTS template (regime-keyed) for the entry type,
   *      or honors `rtsTemplateCode` override.
   *   3. Renders the template against the entry/aircraft/credential
   *      context and freezes the rendered text on the row.
   *   4. Stamps signed_at + signer snapshot.
   *
   * Throws MaintenanceEntryAlreadySignedError if the entry is already
   * signed — there is no double-sign path.
   */
  async sign(input: SignMaintenanceEntryInput): Promise<MaintenanceEntry> {
    const entry = await this.getById(input.tenantId, input.entryId);
    if (entry.signedAt) {
      throw new MaintenanceEntryAlreadySignedError(entry.id);
    }

    const acRows = await this.db
      .select({
        id: aircraft.id,
        registration: aircraft.registration,
        regimeId: aircraft.regimeId,
      })
      .from(aircraft)
      .where(
        and(
          eq(aircraft.tenantId, input.tenantId),
          eq(aircraft.id, entry.aircraftId),
        ),
      );
    const ac = acRows[0];
    if (!ac) {
      throw new MaintenanceEntryAircraftNotFoundError(
        `id=${entry.aircraftId}`,
      );
    }

    const now = input.now ?? new Date();
    const today = now.toISOString().slice(0, 10);

    const credRows = await this.db
      .select({
        credId: userCredentials.id,
        certificateNumber: userCredentials.certificateNumber,
        expiresOn: userCredentials.expiresOn,
      })
      .from(userCredentials)
      .innerJoin(
        regimeCredentialTypes,
        eq(userCredentials.regimeCredentialTypeId, regimeCredentialTypes.id),
      )
      .where(
        and(
          eq(userCredentials.userId, input.signedByUserId),
          eq(regimeCredentialTypes.regimeId, ac.regimeId),
          eq(regimeCredentialTypes.authorizesSignoff, true),
          isNull(userCredentials.revokedAt),
        ),
      );

    // Filter expiry in JS — the credential gate must permit both
    // "no expiry" (expiresOn IS NULL) and "not yet expired".
    const validCred = credRows.find(
      (c) => c.expiresOn === null || c.expiresOn >= today,
    );
    if (!validCred) {
      throw new MaintenanceEntryNotAuthorizedToSignError(input.signedByUserId);
    }

    const templateCode =
      input.rtsTemplateCode ?? recommendRtsTemplateCode(entry.entryType);
    const tplRows = await this.db
      .select()
      .from(regimeRtsTemplates)
      .where(
        and(
          eq(regimeRtsTemplates.regimeId, ac.regimeId),
          eq(regimeRtsTemplates.code, templateCode),
        ),
      );
    const tpl = tplRows[0];
    if (!tpl) {
      throw new MaintenanceEntryTemplateNotFoundError(
        `regime=${ac.regimeId} code=${templateCode}`,
      );
    }

    // If the entry pins an inspection program, pull its name for the
    // {{inspection_program_name}} placeholder.
    let programName: string | null = null;
    if (entry.inspectionProgramId) {
      const prog = await this.db
        .select({ name: dbSchema.regimeInspectionProgramTemplates.name })
        .from(dbSchema.regimeInspectionProgramTemplates)
        .where(
          eq(
            dbSchema.regimeInspectionProgramTemplates.id,
            entry.inspectionProgramId,
          ),
        );
      programName = prog[0]?.name ?? null;
    }

    // Verify the signing user exists; the FK on signed_by_user_id
    // already enforces this, but raising a clean error keeps the
    // UI message coherent.
    const userRows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.signedByUserId));
    if (!userRows[0]) {
      throw new MaintenanceEntryValidationError(
        `signing user not found: ${input.signedByUserId}`,
      );
    }

    const renderedBody = renderRtsTemplate(tpl.body, {
      workPerformed: entry.workPerformed,
      inspectionProgramName: programName,
      aircraftTotalTime: entry.aircraftTotalTime,
      performedOn: entry.performedOn,
      aircraftRegistration: ac.registration,
      certificateNumber: validCred.certificateNumber ?? null,
    });

    const [row] = await this.db
      .update(maintenanceEntries)
      .set({
        signedAt: now,
        signedByUserId: input.signedByUserId,
        signedByCredentialId: validCred.credId,
        signedByCertificateNumber: validCred.certificateNumber ?? null,
        rtsTemplateId: tpl.id,
        rtsRenderedBody: renderedBody,
        updatedAt: now,
      })
      .where(
        and(
          eq(maintenanceEntries.tenantId, input.tenantId),
          eq(maintenanceEntries.id, entry.id),
        ),
      )
      .returning();
    if (!row) {
      throw new MaintenanceEntryNotFoundError(`id=${entry.id}`);
    }
    return row;
  }

  /**
   * Trace the correction chain back to the original entry for the
   * supplied id. Useful for audit views and the F5 (V1) auditor lens.
   */
  async chainOriginal(
    tenantId: string,
    entryId: string,
  ): Promise<MaintenanceEntry> {
    let current = await this.getById(tenantId, entryId);
    const seen = new Set<string>([current.id]);
    while (current.correctionOfId) {
      if (seen.has(current.correctionOfId)) {
        throw new Error(
          `correction chain cycle detected at ${current.correctionOfId}`,
        );
      }
      seen.add(current.correctionOfId);
      current = await this.getById(tenantId, current.correctionOfId);
    }
    return current;
  }
}
