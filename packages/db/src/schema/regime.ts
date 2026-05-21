import {
  boolean,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const regimes = pgTable("regimes", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  jurisdiction: text("jurisdiction").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Inspection programs are regime-owned catalog rows. The `cadenceKind`
 * column is a UI-facing categorical only — the engine determines actual
 * cadence by counting child rows in {@link regimeInspectionProgramIntervals}:
 *
 *   * `single` → exactly one interval row (e.g. annual, 100-hour).
 *   * `whichever_comes_first` → 2+ interval rows; engine takes the
 *     earliest computed due-at across them.
 *   * `custom` → zero interval rows; the operator supplies intervals
 *     per aircraft (e.g. FAA progressive inspection programs).
 *
 * Updates to this column must keep the categorical and the actual
 * child-row count consistent.
 */
export const regimeInspectionProgramTemplates = pgTable(
  "regime_inspection_program_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    regimeId: uuid("regime_id")
      .notNull()
      .references(() => regimes.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    cadenceKind: text("cadence_kind").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    regimeCodeUnique: uniqueIndex("regime_inspection_program_templates_code")
      .on(t.regimeId, t.code),
  }),
);

/**
 * One row per interval on an inspection program. A program with
 * multiple rows represents "whichever comes first" — the engine
 * computes a due-at for each interval and surfaces the earliest.
 *
 * `kind` is the unit-of-measure family:
 *   * `hour`     — value/unit anchored to airframe total time
 *                  (e.g. 100/hours).
 *   * `calendar` — value/unit anchored to a date
 *                  (e.g. 12/months, 24/months).
 *   * `cycle`    — value/unit anchored to airframe cycles
 *                  (e.g. 5000/cycles). Reserved for V2 cycle tracking;
 *                  no FAA MVP program uses it yet.
 */
export const regimeInspectionProgramIntervals = pgTable(
  "regime_inspection_program_intervals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => regimeInspectionProgramTemplates.id, {
        onDelete: "cascade",
      }),
    kind: text("kind").notNull(),
    value: numeric("value").notNull(),
    unit: text("unit").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    templateKindUnitUnique: uniqueIndex(
      "regime_inspection_program_intervals_template_kind_unit",
    ).on(t.templateId, t.kind, t.unit),
  }),
);

export const regimeDirectiveSources = pgTable(
  "regime_directive_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    regimeId: uuid("regime_id")
      .notNull()
      .references(() => regimes.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    sourceUri: text("source_uri"),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    regimeCodeUnique: uniqueIndex("regime_directive_sources_code")
      .on(t.regimeId, t.code),
  }),
);

export const regimeCredentialTypes = pgTable(
  "regime_credential_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    regimeId: uuid("regime_id")
      .notNull()
      .references(() => regimes.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    authorizesSignoff: boolean("authorizes_signoff").notNull().default(false),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    regimeCodeUnique: uniqueIndex("regime_credential_types_code")
      .on(t.regimeId, t.code),
  }),
);

export const regimeRtsTemplates = pgTable(
  "regime_rts_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    regimeId: uuid("regime_id")
      .notNull()
      .references(() => regimes.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    regimeCodeUnique: uniqueIndex("regime_rts_templates_code")
      .on(t.regimeId, t.code),
  }),
);

export const regimeRetentionRules = pgTable(
  "regime_retention_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    regimeId: uuid("regime_id")
      .notNull()
      .references(() => regimes.id, { onDelete: "restrict" }),
    recordKind: text("record_kind").notNull(),
    retentionPeriodKind: text("retention_period_kind").notNull(),
    retentionPeriodValue: integer("retention_period_value"),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    regimeRecordUnique: uniqueIndex("regime_retention_rules_record_kind")
      .on(t.regimeId, t.recordKind),
  }),
);

export type Regime = typeof regimes.$inferSelect;
export type NewRegime = typeof regimes.$inferInsert;

export type RegimeInspectionProgramTemplate =
  typeof regimeInspectionProgramTemplates.$inferSelect;
export type NewRegimeInspectionProgramTemplate =
  typeof regimeInspectionProgramTemplates.$inferInsert;

export type RegimeInspectionProgramInterval =
  typeof regimeInspectionProgramIntervals.$inferSelect;
export type NewRegimeInspectionProgramInterval =
  typeof regimeInspectionProgramIntervals.$inferInsert;

export const INSPECTION_INTERVAL_KINDS = [
  "hour",
  "calendar",
  "cycle",
] as const;
export type InspectionIntervalKind =
  (typeof INSPECTION_INTERVAL_KINDS)[number];

export const INSPECTION_CADENCE_KINDS = [
  "single",
  "whichever_comes_first",
  "custom",
] as const;
export type InspectionCadenceKind =
  (typeof INSPECTION_CADENCE_KINDS)[number];

export type RegimeDirectiveSource = typeof regimeDirectiveSources.$inferSelect;
export type NewRegimeDirectiveSource =
  typeof regimeDirectiveSources.$inferInsert;

export type RegimeCredentialType = typeof regimeCredentialTypes.$inferSelect;
export type NewRegimeCredentialType =
  typeof regimeCredentialTypes.$inferInsert;

export type RegimeRtsTemplate = typeof regimeRtsTemplates.$inferSelect;
export type NewRegimeRtsTemplate = typeof regimeRtsTemplates.$inferInsert;

export type RegimeRetentionRule = typeof regimeRetentionRules.$inferSelect;
export type NewRegimeRetentionRule =
  typeof regimeRetentionRules.$inferInsert;
