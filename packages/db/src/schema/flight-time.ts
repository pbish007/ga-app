import {
  boolean,
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { organizations, users } from "./accounts.js";
import { aircraft } from "./aircraft.js";

export const flightTimeEntries = pgTable(
  "flight_time_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    aircraftId: uuid("aircraft_id")
      .notNull()
      .references(() => aircraft.id, { onDelete: "cascade" }),
    airframeTimeNew: numeric("airframe_time_new", {
      precision: 10,
      scale: 2,
    }).notNull(),
    /** Captured by the BEFORE INSERT trigger from aircraft.airframe_total_time. */
    airframeTimePrev: numeric("airframe_time_prev", {
      precision: 10,
      scale: 2,
    })
      .notNull()
      .default("0"),
    isOverride: boolean("is_override").notNull().default(false),
    /** Required when isOverride=true. Free-text reason for the instrument swap. */
    overrideReason: text("override_reason"),
    enteredAt: timestamp("entered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    enteredByUserId: uuid("entered_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    aircraftIdx: index("fte_aircraft_idx").on(t.aircraftId),
    tenantIdx: index("fte_tenant_idx").on(t.tenantId),
    enteredAtIdx: index("fte_entered_at_idx").on(t.aircraftId, t.enteredAt),
    airframeNonneg: check(
      "fte_airframe_time_new_nonneg",
      sql`${t.airframeTimeNew} >= 0`,
    ),
    overrideReasonRequired: check(
      "fte_override_reason_required",
      sql`NOT ${t.isOverride} OR (${t.overrideReason} IS NOT NULL AND trim(${t.overrideReason}) <> '')`,
    ),
  }),
);

export type FlightTimeEntry = typeof flightTimeEntries.$inferSelect;
export type NewFlightTimeEntry = typeof flightTimeEntries.$inferInsert;
