import {
  bigint,
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

import { organizations, users } from "./accounts.js";

export const STORAGE_PROVIDERS = ["vercel_blob", "memory"] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    documentType: text("document_type").notNull(),
    objectKey: text("object_key").notNull(),
    storageProvider: text("storage_provider")
      .$type<StorageProvider>()
      .notNull()
      .default("vercel_blob"),
    storageUrl: text("storage_url").notNull(),
    originalFilename: text("original_filename").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256Hex: text("sha256_hex").notNull(),
    retentionPeriodDays: integer("retention_period_days"),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    objectKeyUnique: uniqueIndex("documents_object_key_unique").on(t.objectKey),
    tenantTypeIdx: index("documents_tenant_type_idx").on(
      t.tenantId,
      t.documentType,
    ),
    tenantCreatedIdx: index("documents_tenant_created_idx").on(
      t.tenantId,
      t.createdAt,
    ),
    byteSizeNonneg: check("documents_byte_size_nonneg", sql`byte_size >= 0`),
    retentionNonneg: check(
      "documents_retention_nonneg",
      sql`retention_period_days is null or retention_period_days >= 0`,
    ),
  }),
);

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
