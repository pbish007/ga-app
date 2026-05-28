import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestSuite, type TestDb, schema as dbSchema } from "@ga/db";

import {
  CrossTenantDocumentAccessError,
  DocumentNotFoundError,
  DocumentsService,
  MemoryBlobDriver,
} from "../src/index.js";

const { organizations, regimes } = dbSchema;

async function seedOrg(db: TestDb, name: string): Promise<string> {
  const [faa] = await db.select().from(regimes);
  if (!faa) throw new Error("FAA regime not seeded by migration 0001");
  const [org] = await db
    .insert(organizations)
    .values({
      name,
      orgType: "club",
      defaultRegimeId: faa.id,
    })
    .returning();
  if (!org) throw new Error("seed org failed");
  return org.id;
}

describe("DocumentsService (J2.1)", () => {
  let db: TestDb;
  let reset: () => Promise<void>;
  let driver: MemoryBlobDriver;
  let service: DocumentsService;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });

  afterEach(async () => {
    await reset();
  });

  beforeEach(async () => {
    driver = new MemoryBlobDriver();
    service = new DocumentsService(db, driver, "memory");
    tenantA = await seedOrg(db, "Cessna Club A");
    tenantB = await seedOrg(db, "Cessna Club B");
  });

  it("uploads then retrieves the exact same bytes", async () => {
    const payload = new TextEncoder().encode("hello aircraft world");
    const { document } = await service.upload({
      tenantId: tenantA,
      documentType: "maintenance_log",
      originalFilename: "may-2026.txt",
      contentType: "text/plain",
      body: payload,
    });

    expect(document.tenantId).toBe(tenantA);
    expect(document.documentType).toBe("maintenance_log");
    expect(document.byteSize).toBe(payload.byteLength);
    expect(document.sha256Hex).toMatch(/^[0-9a-f]{64}$/);
    expect(document.objectKey).toBe(
      `tenants/${tenantA}/maintenance_log/${document.id}/may-2026.txt`,
    );
    expect(document.storageProvider).toBe("memory");
    expect(document.storageUrl).toMatch(/^memory:\/\/tenants\//);

    const retrieved = await service.retrieve({
      documentId: document.id,
      tenantId: tenantA,
    });
    expect(new TextDecoder().decode(retrieved.body)).toBe(
      "hello aircraft world",
    );
    expect(retrieved.document.id).toBe(document.id);
  });

  it("persists retention_period_days when supplied", async () => {
    const { document } = await service.upload({
      tenantId: tenantA,
      documentType: "annual_inspection",
      originalFilename: "annual.pdf",
      contentType: "application/pdf",
      body: new Uint8Array([1, 2, 3]),
      retentionPeriodDays: 3650,
    });
    expect(document.retentionPeriodDays).toBe(3650);
  });

  it("blocks cross-tenant retrieve with a typed error", async () => {
    const { document } = await service.upload({
      tenantId: tenantA,
      documentType: "maintenance_log",
      originalFilename: "x.txt",
      contentType: "text/plain",
      body: new Uint8Array([1, 2, 3]),
    });
    await expect(
      service.retrieve({ documentId: document.id, tenantId: tenantB }),
    ).rejects.toBeInstanceOf(CrossTenantDocumentAccessError);
  });

  it("returns DocumentNotFoundError when the id is unknown", async () => {
    const bogus = "00000000-0000-0000-0000-deadbeefdead";
    await expect(
      service.retrieve({ documentId: bogus, tenantId: tenantA }),
    ).rejects.toBeInstanceOf(DocumentNotFoundError);
  });

  it("enforces the object_key tenant-prefix check constraint", async () => {
    // Bypass the service to attempt a forged key insert. The DB-level
    // CHECK must catch it even if app code is buggy or compromised.
    await expect(
      db.execute(sql`
        insert into documents
          (tenant_id, document_type, object_key, storage_url,
           original_filename, content_type, byte_size, sha256_hex)
        values
          (${tenantA},
           'maintenance_log',
           ${"tenants/" + tenantB + "/maintenance_log/00000000-0000-0000-0000-000000000001/x.txt"},
           'memory://forged',
           'x.txt', 'text/plain', 3,
           'aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00')
      `),
    ).rejects.toThrow(/documents_object_key_tenant_prefix/);
  });
});
