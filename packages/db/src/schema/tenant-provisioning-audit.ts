import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organizations, users } from "./accounts.js";

export const PROVISIONING_ACTOR_KINDS = [
  "self-service",
  "platform-admin",
  "grandfathered",
] as const;
export type ProvisioningActorKind = (typeof PROVISIONING_ACTOR_KINDS)[number];

export const PROVISIONING_RESULT_STATUSES = [
  "in_progress",
  "done",
  "failed",
] as const;
export type ProvisioningResultStatus =
  (typeof PROVISIONING_RESULT_STATUSES)[number];

/**
 * Append-only audit log for every tenant-provisioning attempt
 * (PMB-117 / V1 Managed onboarding S3). The provisioning service writes
 * an `in_progress` row before opening the org/membership transaction and
 * UPDATEs it to `done` or `failed` once the attempt resolves.
 *
 * See migration 0024 for grants + design notes. tenant_app holds no grant
 * — admin tooling reads the table on the bare runtime connection.
 */
export const tenantProvisioningAudit = pgTable(
  "tenant_provisioning_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Named `created_tenant_id` at the SQL layer rather than `tenant_id`
    // so the FORCE-RLS lint (`tests/force-rls-lint.test.ts`) keeps treating
    // the literal column name as the tenant-scoped marker. This table is
    // NOT tenant-scoped — it's a system audit keyed BY the tenant that an
    // attempt created. See migration 0024 header for the full rationale.
    createdTenantId: uuid("created_tenant_id").references(
      () => organizations.id,
      { onDelete: "set null" },
    ),
    idempotencyKey: text("idempotency_key"),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    actorKind: text("actor_kind").$type<ProvisioningActorKind>().notNull(),
    inputSnapshot: jsonb("input_snapshot").notNull(),
    resultStatus: text("result_status")
      .$type<ProvisioningResultStatus>()
      .notNull()
      .default("in_progress"),
    resultSnapshot: jsonb("result_snapshot"),
    error: jsonb("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    // Partial UNIQUE on idempotency_key — matches the SQL migration. Multiple
    // NULL keys are allowed (self-service signup); a non-NULL key is unique.
    idempotencyKeyUnique: uniqueIndex(
      "tenant_provisioning_audit_idempotency_key_unique",
    )
      .on(t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    createdAtIdx: index("tenant_provisioning_audit_created_at_idx").on(
      t.createdAt,
    ),
  }),
);

export type TenantProvisioningAuditRow =
  typeof tenantProvisioningAudit.$inferSelect;
export type NewTenantProvisioningAuditRow =
  typeof tenantProvisioningAudit.$inferInsert;
