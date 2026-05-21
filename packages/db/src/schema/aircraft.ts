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
import { regimes } from "./regime.js";

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
