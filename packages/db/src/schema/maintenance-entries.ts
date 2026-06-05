import {
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  date,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { organizations, users } from "./accounts.js";
import { aircraft } from "./aircraft.js";
import { userCredentials } from "./credentials.js";
import { importJobRows } from "./import-jobs.js";
import {
  regimeInspectionProgramTemplates,
  regimeRtsTemplates,
} from "./regime.js";

/**
 * Controlled vocabulary of maintenance entry types (PMB-16, Epic F).
 *
 * The type drives RTS template selection: F2 maps each type to the
 * regime-owned RTS template the sign() flow uses by default. The
 * mapping is data, not code — see `recommendRtsTemplateCode` in the
 * service layer.
 *
 * Neutral-entity naming per spec §3.3: prefer "inspection_program"
 * over "annual_only" when the operator runs a non-annual program
 * (progressive, etc.).
 */
export const MAINTENANCE_ENTRY_TYPES = [
  "maintenance",
  "annual_inspection",
  "100_hour_inspection",
  "inspection_program",
  "ad_compliance",
] as const;
export type MaintenanceEntryType = (typeof MAINTENANCE_ENTRY_TYPES)[number];

/**
 * F1 maintenance entry row.
 *
 * Pre-sign half: work_performed, performed_on, aircraft_total_time,
 * entry_type, inspection_program_id. Filled when the mechanic drafts.
 *
 * Sign half: signed_at, signed_by_user_id, signed_by_credential_id,
 * signed_by_certificate_number, rts_template_id, rts_rendered_body.
 * Filled atomically by the sign() flow when an A2-credentialed user
 * releases the aircraft.
 *
 * IMMUTABILITY: once signed_at IS NOT NULL the DB rejects any UPDATE
 * via the `maintenance_entries_block_signed_update` trigger (see
 * migration 0013). Corrections are NEW rows whose `correction_of_id`
 * points at the prior entry — never in-place edits. This is spec §3.1
 * "Data Integrity Over Convenience" enforced at the data layer.
 *
 * The rts_rendered_body column is a frozen snapshot of the regime
 * template body at the moment of sign-off; later edits to the regime
 * template do NOT change historic entries — an inspector reading a
 * 2026 entry must see the 2026 wording.
 */
export const maintenanceEntries = pgTable(
  "maintenance_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    aircraftId: uuid("aircraft_id")
      .notNull()
      .references(() => aircraft.id, { onDelete: "cascade" }),
    entryType: text("entry_type").$type<MaintenanceEntryType>().notNull(),
    workPerformed: text("work_performed").notNull(),
    performedOn: date("performed_on", { mode: "string" }).notNull(),
    aircraftTotalTime: numeric("aircraft_total_time", {
      precision: 10,
      scale: 2,
    }).notNull(),
    inspectionProgramId: uuid("inspection_program_id").references(
      () => regimeInspectionProgramTemplates.id,
      { onDelete: "restrict" },
    ),
    correctionOfId: uuid("correction_of_id").references(
      (): AnyPgColumn => maintenanceEntries.id,
      { onDelete: "restrict" },
    ),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    signedByUserId: uuid("signed_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    signedByCredentialId: uuid("signed_by_credential_id").references(
      () => userCredentials.id,
      { onDelete: "restrict" },
    ),
    signedByCertificateNumber: text("signed_by_certificate_number"),
    rtsTemplateId: uuid("rts_template_id").references(
      () => regimeRtsTemplates.id,
      { onDelete: "restrict" },
    ),
    rtsRenderedBody: text("rts_rendered_body"),
    /**
     * PMB-157 traceability hook: when this entry was materialized by
     * the V1 importer, points at the staging row it came from. NULL
     * for every interactively-drafted entry. Set at INSERT time only;
     * the signed-row immutability trigger still applies on update.
     */
    sourceImportRowId: uuid("source_import_row_id").references(
      (): AnyPgColumn => importJobRows.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantIdx: index("maintenance_entries_tenant_idx").on(t.tenantId),
    aircraftIdx: index("maintenance_entries_aircraft_idx").on(t.aircraftId),
    sourceImportRowIdx: index("maintenance_entries_source_import_row_idx")
      .on(t.sourceImportRowId)
      .where(sql`${t.sourceImportRowId} is not null`),
    entryTypeCheck: check(
      "maintenance_entries_entry_type_check",
      sql`${t.entryType} in ('maintenance', 'annual_inspection', '100_hour_inspection', 'inspection_program', 'ad_compliance')`,
    ),
    workPerformedNonEmpty: check(
      "maintenance_entries_work_performed_nonempty",
      sql`length(trim(${t.workPerformed})) > 0`,
    ),
    airframeNonneg: check(
      "maintenance_entries_airframe_nonneg",
      sql`${t.aircraftTotalTime} >= 0`,
    ),
  }),
);

export type MaintenanceEntry = typeof maintenanceEntries.$inferSelect;
export type NewMaintenanceEntry = typeof maintenanceEntries.$inferInsert;
