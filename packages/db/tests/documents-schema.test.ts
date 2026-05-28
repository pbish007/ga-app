import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestSuite, type TestDb } from "../src/index.js";

describe("0003_create_documents migration (PMB-20)", () => {
  let db: TestDb;

  beforeAll(async () => {
    ({ db } = await setupTestSuite());
  });

  it("creates a documents table with the J2.1 columns", async () => {
    const result = await db.execute<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(sql`
      select column_name, data_type, is_nullable
        from information_schema.columns
       where table_schema = 'public' and table_name = 'documents'
       order by column_name
    `);
    const names = result.rows.map((r) => r.column_name).sort();
    expect(names).toEqual([
      "byte_size",
      "content_type",
      "created_at",
      "deleted_at",
      "document_type",
      "id",
      "object_key",
      "original_filename",
      "retention_period_days",
      "sha256_hex",
      "storage_provider",
      "storage_url",
      "tenant_id",
      "uploaded_by_user_id",
    ]);
  });

  it("forces row level security on documents (fail closed for non-superusers)", async () => {
    const result = await db.execute<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(sql`
      select relrowsecurity, relforcerowsecurity
        from pg_class where relname = 'documents'
    `);
    expect(result.rows[0]?.relrowsecurity).toBe(true);
    expect(result.rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("has a unique index on object_key", async () => {
    const result = await db.execute<{ indexname: string; indexdef: string }>(sql`
      select indexname, indexdef from pg_indexes
       where tablename = 'documents' and indexname = 'documents_object_key_unique'
    `);
    expect(result.rows[0]?.indexdef ?? "").toMatch(/UNIQUE INDEX/);
  });
});
