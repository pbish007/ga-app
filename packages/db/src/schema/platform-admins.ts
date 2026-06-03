import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { users } from "./accounts.js";

/**
 * Platform-admin identity primitive (PMB-116). Append-only: revocations
 * set `revokedAt`, they do not delete the row. Tenant_app has no grant
 * on this table — the runtime gate reads it on the bare connection role
 * before any tenant tx begins. See migration 0023 for full design notes.
 */
export const platformAdmins = pgTable("platform_admins", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  grantedByUserId: uuid("granted_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  grantedAt: timestamp("granted_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  note: text("note"),
});

export type PlatformAdmin = typeof platformAdmins.$inferSelect;
export type NewPlatformAdmin = typeof platformAdmins.$inferInsert;
