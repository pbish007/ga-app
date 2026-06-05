import {
  check,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { organizations, users } from "./accounts.js";
import { regimeCredentialTypes } from "./regime.js";

/**
 * A user's regulatory credential (A&P, IA, repairman, …) modelled as a
 * row pointing at the data-driven `regime_credential_types` table.
 *
 * Tenant-agnostic — credentials follow the person across the orgs they
 * belong to. The sign-off check reads
 * `regime_credential_types.authorizes_signoff`; app code never switches
 * on credential code strings. See migration `0006_user_credentials.sql`
 * and the A2.3 ticket on PMB-34 for the design contract.
 *
 * `ratings` (multi-value) and `created_by_user_id` land in migration
 * 0027 for PMB-155 (Epic G). Per-tenant admin authorisation lives at
 * the API boundary (`withRequest({ permission: 'credential.manage' })`
 * + membership join); the row itself stays person-scoped.
 */
export const userCredentials = pgTable(
  "user_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    regimeCredentialTypeId: uuid("regime_credential_type_id")
      .notNull()
      .references(() => regimeCredentialTypes.id, { onDelete: "restrict" }),
    certificateNumber: text("certificate_number"),
    ratings: text("ratings")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    issuedOn: date("issued_on", { mode: "string" }).notNull(),
    expiresOn: date("expires_on", { mode: "string" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    activeIdx: index("user_credentials_active_idx").on(
      t.userId,
      t.regimeCredentialTypeId,
    ),
  }),
);

export type UserCredential = typeof userCredentials.$inferSelect;
export type NewUserCredential = typeof userCredentials.$inferInsert;

/**
 * Append-only audit log for credential CRUD (PMB-155). Every
 * create/update/revoke writes one row inside the same transaction as
 * the credential mutation, so a failure rolls both back.
 *
 * Tenant-scoped + RLS-enforced: an admin acting on behalf of tenant A
 * writes a row with `tenant_id = A`; a tenant-B reader cannot see it.
 * This is the row-level tenant trail required by PMB-155 — the
 * credential row itself remains person-scoped (see {@link userCredentials}).
 *
 * Append-only enforced at three layers:
 *   * DB grant — `tenant_app` has SELECT/INSERT only, no UPDATE/DELETE.
 *   * Trigger — `BEFORE UPDATE` raises an exception.
 *   * Schema  — no update path is exported from the service layer.
 */
export const userCredentialChanges = pgTable(
  "user_credential_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userCredentialId: uuid("user_credential_id").references(
      () => userCredentials.id,
      { onDelete: "set null" },
    ),
    targetUserId: uuid("target_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    beforeSnapshot: jsonb("before_snapshot"),
    afterSnapshot: jsonb("after_snapshot"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantIdx: index("user_credential_changes_tenant_idx").on(t.tenantId),
    targetIdx: index("user_credential_changes_target_idx").on(
      t.targetUserId,
      t.createdAt,
    ),
    credentialIdx: index("user_credential_changes_credential_idx").on(
      t.userCredentialId,
      t.createdAt,
    ),
    actionCheck: check(
      "user_credential_changes_action_check",
      sql`${t.action} in ('create', 'update', 'revoke')`,
    ),
  }),
);

export type UserCredentialChange = typeof userCredentialChanges.$inferSelect;
export type NewUserCredentialChange =
  typeof userCredentialChanges.$inferInsert;

export const CREDENTIAL_AUDIT_ACTIONS = ["create", "update", "revoke"] as const;
export type CredentialAuditAction = (typeof CREDENTIAL_AUDIT_ACTIONS)[number];
