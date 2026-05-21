import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { organizations } from "./accounts.js";
import { aircraft } from "./aircraft.js";

/**
 * Component kinds tracked for FAA-style maintenance: engines and
 * propellers are first-class; everything else (e.g. an ELT, a
 * transponder, a vacuum pump) is an "appliance". Avionics deep-dive
 * lives in V1 / Epic B3.
 */
export const COMPONENT_KINDS = ["engine", "propeller", "appliance"] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export const components = pgTable(
  "components",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ComponentKind>().notNull(),
    serialNumber: text("serial_number").notNull(),
    make: text("make"),
    model: text("model"),
    tboHours: numeric("tbo_hours", { precision: 10, scale: 2 }),
    tboCalendarMonths: integer("tbo_calendar_months"),
    cycleLimit: integer("cycle_limit"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantKindSerialUnique: uniqueIndex(
      "components_tenant_kind_serial_unique",
    ).on(t.tenantId, t.kind, sql`lower(${t.serialNumber})`),
    tenantIdx: index("components_tenant_idx").on(t.tenantId),
    kindCheck: check(
      "components_kind_check",
      sql`${t.kind} in ('engine', 'propeller', 'appliance')`,
    ),
    tboHoursPos: check(
      "components_tbo_hours_pos",
      sql`${t.tboHours} is null or ${t.tboHours} > 0`,
    ),
    tboCalendarPos: check(
      "components_tbo_calendar_pos",
      sql`${t.tboCalendarMonths} is null or ${t.tboCalendarMonths} > 0`,
    ),
    cycleLimitPos: check(
      "components_cycle_limit_pos",
      sql`${t.cycleLimit} is null or ${t.cycleLimit} > 0`,
    ),
  }),
);

/**
 * The install/remove history for a component. The currently-installed
 * row for a component is the one with `removedAt IS NULL`; a partial
 * unique index keeps that to at most one at a time.
 *
 * `installedAtAircraftTotalTime` is the airframe TT snapshot at install,
 * so component time-in-service is `aircraft.airframeTotalTime - that`
 * for active installations, and `removedAtAircraftTotalTime - that`
 * for completed ones.
 */
export const componentInstallations = pgTable(
  "component_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    componentId: uuid("component_id")
      .notNull()
      .references(() => components.id, { onDelete: "cascade" }),
    aircraftId: uuid("aircraft_id")
      .notNull()
      .references(() => aircraft.id, { onDelete: "cascade" }),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull(),
    installedAtAircraftTotalTime: numeric("installed_at_aircraft_total_time", {
      precision: 10,
      scale: 2,
    }).notNull(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedAtAircraftTotalTime: numeric("removed_at_aircraft_total_time", {
      precision: 10,
      scale: 2,
    }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    activeUnique: uniqueIndex("component_installations_active_unique")
      .on(t.componentId)
      .where(sql`${t.removedAt} is null`),
    aircraftActiveIdx: index("component_installations_aircraft_active_idx")
      .on(t.aircraftId)
      .where(sql`${t.removedAt} is null`),
    componentIdx: index("component_installations_component_idx").on(
      t.componentId,
    ),
    tenantIdx: index("component_installations_tenant_idx").on(t.tenantId),
    removedConsistency: check(
      "component_installations_removed_consistency",
      sql`(${t.removedAt} is null) = (${t.removedAtAircraftTotalTime} is null)`,
    ),
    removedAfterInstalled: check(
      "component_installations_removed_after_installed",
      sql`${t.removedAt} is null or ${t.removedAt} >= ${t.installedAt}`,
    ),
    installTtNonneg: check(
      "component_installations_install_tt_nonneg",
      sql`${t.installedAtAircraftTotalTime} >= 0`,
    ),
    removeTtGteInstall: check(
      "component_installations_remove_tt_gte_install",
      sql`${t.removedAtAircraftTotalTime} is null
          or ${t.removedAtAircraftTotalTime} >= ${t.installedAtAircraftTotalTime}`,
    ),
  }),
);

export type Component = typeof components.$inferSelect;
export type NewComponent = typeof components.$inferInsert;
export type ComponentInstallation = typeof componentInstallations.$inferSelect;
export type NewComponentInstallation =
  typeof componentInstallations.$inferInsert;
