import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { organizations, users, emailOutbox } from "./accounts.js";
import { aircraft } from "./aircraft.js";
import { regimeInspectionProgramTemplates } from "./regime.js";

export const NOTIFICATION_LEVELS = ["due_soon", "overdue"] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emailLeadTimeDays: integer("email_lead_time_days").notNull().default(14),
    emailEnabled: boolean("email_enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantUserUnique: uniqueIndex(
      "notification_preferences_tenant_user_unique",
    ).on(t.tenantId, t.userId),
    tenantIdx: index("notification_preferences_tenant_idx").on(t.tenantId),
    userIdx: index("notification_preferences_user_idx").on(t.userId),
    leadTimePositive: check(
      "notification_preferences_lead_time_positive",
      sql`${t.emailLeadTimeDays} >= 0 and ${t.emailLeadTimeDays} <= 365`,
    ),
  }),
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    aircraftId: uuid("aircraft_id")
      .notNull()
      .references(() => aircraft.id, { onDelete: "cascade" }),
    programId: uuid("program_id")
      .notNull()
      .references(() => regimeInspectionProgramTemplates.id, {
        onDelete: "restrict",
      }),
    level: text("level").$type<NotificationLevel>().notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    cycleKey: text("cycle_key").notNull(),
    deliverEmail: boolean("deliver_email").notNull(),
    emailOutboxId: uuid("email_outbox_id").references(() => emailOutbox.id, {
      onDelete: "set null",
    }),
    seenAt: timestamp("seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idempotencyUnique: uniqueIndex("notifications_idempotency_unique").on(
      t.tenantId,
      t.userId,
      t.aircraftId,
      t.programId,
      t.level,
      t.cycleKey,
    ),
    tenantIdx: index("notifications_tenant_idx").on(t.tenantId),
    userIdx: index("notifications_user_idx").on(t.tenantId, t.userId),
    aircraftIdx: index("notifications_aircraft_idx").on(t.aircraftId),
    levelCheck: check(
      "notifications_level_check",
      sql`${t.level} in ('due_soon', 'overdue')`,
    ),
  }),
);

export type NotificationPreferences =
  typeof notificationPreferences.$inferSelect;
export type NewNotificationPreferences =
  typeof notificationPreferences.$inferInsert;
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
