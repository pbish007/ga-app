import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { organizations, users } from "./accounts.js";
import { aircraft } from "./aircraft.js";
import { documents } from "./documents.js";

/**
 * Severity ladder for E1 (PMB-13). Source: spec Rev. 3 §4 Epic E.
 *
 *   * informational — note only.
 *   * deferred      — discrepancy acknowledged, work deferred per MEL/policy.
 *   * grounding     — aircraft is NOT airworthy until resolved.
 *
 * The ladder is intentionally short; finer-grained categories belong on
 * the work-order / estimate stories (E2/E3, V1/V2 — out of scope here).
 */
export const SQUAWK_SEVERITIES = [
  "informational",
  "deferred",
  "grounding",
] as const;
export type SquawkSeverity = (typeof SQUAWK_SEVERITIES)[number];

export const SQUAWK_STATUSES = ["open", "resolved"] as const;
export type SquawkStatus = (typeof SQUAWK_STATUSES)[number];

export const squawks = pgTable(
  "squawks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    aircraftId: uuid("aircraft_id")
      .notNull()
      .references(() => aircraft.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    /** When the pilot observed the discrepancy (not the same as createdAt). */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    reporterUserId: uuid("reporter_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    severity: text("severity").$type<SquawkSeverity>().notNull(),
    status: text("status").$type<SquawkStatus>().notNull().default("open"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    resolutionNotes: text("resolution_notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantIdx: index("squawks_tenant_idx").on(t.tenantId),
    aircraftIdx: index("squawks_aircraft_idx").on(t.aircraftId),
    severityCheck: check(
      "squawks_severity_check",
      sql`${t.severity} in ('informational', 'deferred', 'grounding')`,
    ),
    statusCheck: check(
      "squawks_status_check",
      sql`${t.status} in ('open', 'resolved')`,
    ),
    descriptionNonEmpty: check(
      "squawks_description_nonempty",
      sql`length(trim(${t.description})) > 0`,
    ),
    resolvedShape: check(
      "squawks_resolved_shape",
      sql`(${t.status} = 'open' AND ${t.resolvedAt} IS NULL AND ${t.resolvedByUserId} IS NULL)
          OR (${t.status} = 'resolved' AND ${t.resolvedAt} IS NOT NULL)`,
    ),
  }),
);

export type Squawk = typeof squawks.$inferSelect;
export type NewSquawk = typeof squawks.$inferInsert;

/**
 * Join table from a squawk to durable photo evidence stored in the J2.1
 * documents table. Multi-photo squawks are the norm — a maintainer wants
 * the overall, the close-up, and the data-plate photo.
 */
export const squawkPhotos = pgTable(
  "squawk_photos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    squawkId: uuid("squawk_id")
      .notNull()
      .references(() => squawks.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    squawkDocumentUnique: uniqueIndex("squawk_photos_squawk_document_unique").on(
      t.squawkId,
      t.documentId,
    ),
    tenantIdx: index("squawk_photos_tenant_idx").on(t.tenantId),
    squawkIdx: index("squawk_photos_squawk_idx").on(t.squawkId),
    documentIdx: index("squawk_photos_document_idx").on(t.documentId),
  }),
);

export type SquawkPhoto = typeof squawkPhotos.$inferSelect;
export type NewSquawkPhoto = typeof squawkPhotos.$inferInsert;
