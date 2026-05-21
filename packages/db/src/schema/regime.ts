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
    intervalValue: numeric("interval_value"),
    intervalUnit: text("interval_unit"),
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
