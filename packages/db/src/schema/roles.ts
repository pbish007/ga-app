import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { APP_ROLE_CODES, type AppRoleCode } from "./accounts.js";

export const APP_PERMISSION_CODES = [
  "aircraft.read",
  "aircraft.write",
  "aircraft.change_regime",
  "inspection.read",
  "inspection.write",
  "signoff.create",
  "signoff.read",
  "org.manage_users",
  "credential.manage",
] as const;
export type AppPermissionCode = (typeof APP_PERMISSION_CODES)[number];

export const appRoles = pgTable("app_roles", {
  code: text("code").$type<AppRoleCode>().primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const appPermissions = pgTable("app_permissions", {
  code: text("code").$type<AppPermissionCode>().primaryKey(),
  description: text("description").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const appRolePermissions = pgTable(
  "app_role_permissions",
  {
    roleCode: text("role_code")
      .$type<AppRoleCode>()
      .notNull()
      .references(() => appRoles.code, { onDelete: "cascade" }),
    permissionCode: text("permission_code")
      .$type<AppPermissionCode>()
      .notNull()
      .references(() => appPermissions.code, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.roleCode, t.permissionCode] }),
  }),
);

export type AppRoleRow = typeof appRoles.$inferSelect;
export type AppPermissionRow = typeof appPermissions.$inferSelect;
export type AppRolePermissionRow = typeof appRolePermissions.$inferSelect;

export { APP_ROLE_CODES, type AppRoleCode };
