import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { organizations, users } from "./accounts.js";
import { importJobRows } from "./import-jobs.js";
import { regimes, regimeInspectionProgramTemplates } from "./regime.js";

/**
 * The two airframe time sources the FAA recognises for hour-based
 * inspection tracking. The compliance engine (Epic D) reads this column
 * to know which delta to apply when a flight is logged in Epic C.
 *
 * If a future regime requires a third source (e.g. flight time via
 * recording engine monitor), add it here AND extend the CHECK constraint
 * in a follow-up migration. The seam is the regime row; the vocabulary
 * is application-layer.
 */
export const AIRCRAFT_TIME_SOURCES = ["hobbs", "tach"] as const;
export type AircraftTimeSource = (typeof AIRCRAFT_TIME_SOURCES)[number];

export const aircraft = pgTable(
  "aircraft",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * K2 regime seam. NOT NULL, NO DEFAULT — every aircraft is born under
     * a regime. App code reads regime-driven values through
     * `RegimeClient.getById(aircraft.regimeId)` and never literals.
     */
    regimeId: uuid("regime_id")
      .notNull()
      .references(() => regimes.id, { onDelete: "restrict" }),
    registration: text("registration").notNull(),
    make: text("make").notNull(),
    model: text("model").notNull(),
    serialNumber: text("serial_number").notNull(),
    yearManufactured: integer("year_manufactured"),
    category: text("category").notNull(),
    aircraftClass: text("aircraft_class").notNull(),
    airframeTotalTime: numeric("airframe_total_time", {
      precision: 10,
      scale: 2,
    })
      .notNull()
      .default("0"),
    timeSource: text("time_source").$type<AircraftTimeSource>().notNull(),
    /**
     * PMB-157 traceability hook: when this row was materialized by the
     * V1 importer, points at the staging row it came from. NULL for
     * every interactive (front-door) aircraft.
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
    tenantRegistrationUnique: uniqueIndex(
      "aircraft_tenant_registration_unique",
    ).on(t.tenantId, sql`lower(${t.registration})`),
    tenantIdx: index("aircraft_tenant_idx").on(t.tenantId),
    regimeIdx: index("aircraft_regime_idx").on(t.regimeId),
    sourceImportRowIdx: index("aircraft_source_import_row_idx")
      .on(t.sourceImportRowId)
      .where(sql`${t.sourceImportRowId} is not null`),
    timeSourceCheck: check(
      "aircraft_time_source_check",
      sql`${t.timeSource} in ('hobbs', 'tach')`,
    ),
    airframeNonneg: check(
      "aircraft_airframe_total_time_nonneg",
      sql`${t.airframeTotalTime} >= 0`,
    ),
    yearRange: check(
      "aircraft_year_manufactured_range",
      sql`${t.yearManufactured} is null or (${t.yearManufactured} between 1900 and 2100)`,
    ),
  }),
);

export type Aircraft = typeof aircraft.$inferSelect;
export type NewAircraft = typeof aircraft.$inferInsert;

/**
 * Subscribes an aircraft to a regime-owned inspection program. The row
 * holds the state the compliance engine needs to compute a due-at:
 * the last-complied anchors (date, airframe time, cycles) and the
 * per-subscription due-soon thresholds.
 *
 * `(aircraft_id, program_id)` is unique — an aircraft is subscribed
 * to a given program at most once. Tenants are isolated by RLS on
 * `tenant_id`.
 */
export const aircraftInspectionSubscriptions = pgTable(
  "aircraft_inspection_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    aircraftId: uuid("aircraft_id")
      .notNull()
      .references(() => aircraft.id, { onDelete: "cascade" }),
    programId: uuid("program_id")
      .notNull()
      .references(() => regimeInspectionProgramTemplates.id, {
        onDelete: "restrict",
      }),
    lastCompliedAt: timestamp("last_complied_at", { withTimezone: true }),
    lastCompliedAirframeTime: numeric("last_complied_airframe_time", {
      precision: 10,
      scale: 2,
    }),
    lastCompliedCycles: integer("last_complied_cycles"),
    dueSoonDaysThreshold: integer("due_soon_days_threshold")
      .notNull()
      .default(30),
    dueSoonHoursThreshold: numeric("due_soon_hours_threshold", {
      precision: 10,
      scale: 2,
    })
      .notNull()
      .default("10"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    aircraftProgramUnique: uniqueIndex("ais_aircraft_program_unique").on(
      t.aircraftId,
      t.programId,
    ),
    tenantIdx: index("ais_tenant_idx").on(t.tenantId),
    aircraftIdx: index("ais_aircraft_idx").on(t.aircraftId),
    compliedAirframeNonneg: check(
      "ais_complied_airframe_nonneg",
      sql`${t.lastCompliedAirframeTime} is null or ${t.lastCompliedAirframeTime} >= 0`,
    ),
    compliedCyclesNonneg: check(
      "ais_complied_cycles_nonneg",
      sql`${t.lastCompliedCycles} is null or ${t.lastCompliedCycles} >= 0`,
    ),
    dueSoonDaysPositive: check(
      "ais_due_soon_days_positive",
      sql`${t.dueSoonDaysThreshold} > 0`,
    ),
    dueSoonHoursPositive: check(
      "ais_due_soon_hours_positive",
      sql`${t.dueSoonHoursThreshold} > 0`,
    ),
  }),
);

export type AircraftInspectionSubscription =
  typeof aircraftInspectionSubscriptions.$inferSelect;
export type NewAircraftInspectionSubscription =
  typeof aircraftInspectionSubscriptions.$inferInsert;

/**
 * Append-only audit log for K2 regime changes (PMB-18). Every mutation
 * of `aircraft.regime_id` lands here with the actor, the from/to
 * regime ids, a timestamp, and an operator-supplied reason. Retention
 * for these rows is `regime_change` on {@link regimeRetentionRules};
 * the application MUST NOT hardcode a retention period for them.
 *
 * The table is enforced append-only at three layers:
 *   * DB grant — `tenant_app` has SELECT/INSERT only, no UPDATE.
 *   * Trigger — `BEFORE UPDATE` raises an exception (belt and braces).
 *   * Schema  — no update path is exported from the service layer.
 */
export const aircraftRegimeChanges = pgTable(
  "aircraft_regime_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    aircraftId: uuid("aircraft_id")
      .notNull()
      .references(() => aircraft.id, { onDelete: "cascade" }),
    fromRegimeId: uuid("from_regime_id")
      .notNull()
      .references(() => regimes.id, { onDelete: "restrict" }),
    toRegimeId: uuid("to_regime_id")
      .notNull()
      .references(() => regimes.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantIdx: index("aircraft_regime_changes_tenant_idx").on(t.tenantId),
    aircraftIdx: index("aircraft_regime_changes_aircraft_idx").on(
      t.aircraftId,
      t.createdAt,
    ),
    distinctRegimes: check(
      "aircraft_regime_changes_distinct_regimes",
      sql`${t.fromRegimeId} <> ${t.toRegimeId}`,
    ),
    reasonNonempty: check(
      "aircraft_regime_changes_reason_nonempty",
      sql`length(trim(${t.reason})) > 0`,
    ),
  }),
);

export type AircraftRegimeChange = typeof aircraftRegimeChanges.$inferSelect;
export type NewAircraftRegimeChange =
  typeof aircraftRegimeChanges.$inferInsert;

/**
 * Decision kinds the operator can take on a per-field FAA Registry
 * prefill conflict. Mirrors the UX pattern's `FaaFieldState` union for
 * the three terminal user-driven states (PMB-112). `loading`, `aligned`,
 * `conflict`, and `no_faa_data` are derived at request time and not
 * persisted — only an explicit user decision lands here.
 */
export const FAA_FIELD_DECISIONS = [
  "accepted_faa",
  "tenant_wins",
  "faa_reported_wrong",
] as const;
export type FaaFieldDecision = (typeof FAA_FIELD_DECISIONS)[number];

export const FAA_FIELD_REPORT_REASONS = [
  "registry_typo",
  "stale_data",
  "wrong_tail",
  "other",
] as const;
export type FaaFieldReportReason = (typeof FAA_FIELD_REPORT_REASONS)[number];

/**
 * Canonical keys for the FAA-prefillable fields on the aircraft form.
 * Defined here (not the FAA pipeline) because the decision-log grain
 * is tenant-side, and the FE/BE form contract is the one that decides
 * which fields are even prefillable in the MVP.
 *
 * Adding a new key: extend this array AND surface it in the FE chip
 * mapping. The DB column is plain text so no schema migration is
 * required — the application boundary is the validator.
 */
export const FAA_FIELD_KEYS = [
  "make",
  "model",
  "serial_number",
  "year_manufactured",
  "owner_name",
  "expiration_date",
] as const;
export type FaaFieldKey = (typeof FAA_FIELD_KEYS)[number];

export const aircraftFaaFieldDecisions = pgTable(
  "aircraft_faa_field_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    aircraftId: uuid("aircraft_id")
      .notNull()
      .references(() => aircraft.id, { onDelete: "cascade" }),
    nNumber: text("n_number").notNull(),
    fieldKey: text("field_key").$type<FaaFieldKey>().notNull(),
    decision: text("decision").$type<FaaFieldDecision>().notNull(),
    faaValue: text("faa_value"),
    /**
     * sha256 of {@link faaValue} at decision time, lowercase hex. The
     * pipeline's nightly sync uses this to honor the anti-nag invariant
     * (PMB-112 AC3) — only re-open a chip if the FAA value's hash has
     * moved off this pinned value.
     */
    faaValueHash: text("faa_value_hash").notNull(),
    tenantValue: text("tenant_value"),
    reportReason: text("report_reason").$type<FaaFieldReportReason>(),
    reportNote: text("report_note"),
    decidedByUserId: uuid("decided_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    decidedAt: timestamp("decided_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantIdx: index("aircraft_faa_field_decisions_tenant_idx").on(t.tenantId),
    nNumberIdx: index("aircraft_faa_field_decisions_n_number_idx").on(
      t.nNumber,
    ),
    aircraftFieldUnique: uniqueIndex(
      "aircraft_faa_field_decisions_aircraft_field_unique",
    ).on(t.aircraftId, t.fieldKey),
  }),
);

export type AircraftFaaFieldDecision =
  typeof aircraftFaaFieldDecisions.$inferSelect;
export type NewAircraftFaaFieldDecision =
  typeof aircraftFaaFieldDecisions.$inferInsert;
