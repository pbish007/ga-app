import { describe, expect, it, beforeEach } from "vitest";

import { setupTestDb, type TestDb, schema as dbSchema } from "@ga/db";
import { DocumentsService, MemoryBlobDriver } from "@ga/storage";

import {
  handleAttachmentRetrieve,
  handleAttachmentUpload,
} from "../lib/attachments-handler";

const { organizations, regimes } = dbSchema;

async function seedOrg(db: TestDb, name: string): Promise<string> {
  const [faa] = await db.select().from(regimes);
  if (!faa) throw new Error("FAA regime seed missing");
  const [org] = await db
    .insert(organizations)
    .values({ name, orgType: "club", defaultRegimeId: faa.id })
    .returning();
  if (!org) throw new Error("seed org failed");
  return org.id;
}

function uploadRequest(form: FormData): Request {
  return new Request("https://example.test/api/attachments", {
    method: "POST",
    body: form,
  });
}

function retrieveRequest(documentId: string, tenantId: string): Request {
  return new Request(
    `https://example.test/api/attachments/${documentId}?tenant_id=${tenantId}`,
    { method: "GET" },
  );
}

describe("attachments handlers (PMB-20)", () => {
  let db: TestDb;
  let service: DocumentsService;
  let tenantA: string;
  let tenantB: string;

  beforeEach(async () => {
    db = await setupTestDb();
    const driver = new MemoryBlobDriver();
    service = new DocumentsService(db, driver, "memory");
    tenantA = await seedOrg(db, "Tenant A");
    tenantB = await seedOrg(db, "Tenant B");
  });

  it("round-trips upload → retrieve and preserves bytes/content-type/filename", async () => {
    const payload = new TextEncoder().encode("the quick brown aircraft");
    const file = new File([payload], "logbook may-2026.txt", {
      type: "text/plain",
    });
    const form = new FormData();
    form.set("file", file);
    form.set("tenant_id", tenantA);
    form.set("document_type", "maintenance_log");
    form.set("retention_period_days", "365");

    const uploadRes = await handleAttachmentUpload(uploadRequest(form), {
      service,
    });
    expect(uploadRes.status).toBe(201);
    const created = (await uploadRes.json()) as {
      id: string;
      tenant_id: string;
      document_type: string;
      object_key: string;
      original_filename: string;
      content_type: string;
      byte_size: number;
      sha256_hex: string;
      retention_period_days: number;
    };
    expect(created.tenant_id).toBe(tenantA);
    expect(created.document_type).toBe("maintenance_log");
    expect(created.object_key.startsWith(`tenants/${tenantA}/`)).toBe(true);
    expect(created.byte_size).toBe(payload.byteLength);
    expect(created.retention_period_days).toBe(365);
    expect(created.sha256_hex).toMatch(/^[0-9a-f]{64}$/);

    const retrieveRes = await handleAttachmentRetrieve(
      retrieveRequest(created.id, tenantA),
      { params: { id: created.id } },
      { service },
    );
    expect(retrieveRes.status).toBe(200);
    expect(retrieveRes.headers.get("Content-Type")).toBe("text/plain");
    expect(retrieveRes.headers.get("Content-Disposition")).toContain(
      "filename*=UTF-8''",
    );
    expect(retrieveRes.headers.get("X-Document-Sha256")).toBe(created.sha256_hex);
    const buf = new Uint8Array(await retrieveRes.arrayBuffer());
    expect(new TextDecoder().decode(buf)).toBe("the quick brown aircraft");
  });

  it("returns 404 on cross-tenant retrieve (does not leak existence)", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3])], "x.bin", { type: "application/octet-stream" }));
    form.set("tenant_id", tenantA);
    form.set("document_type", "maintenance_log");
    const uploadRes = await handleAttachmentUpload(uploadRequest(form), {
      service,
    });
    const created = (await uploadRes.json()) as { id: string };

    const res = await handleAttachmentRetrieve(
      retrieveRequest(created.id, tenantB),
      { params: { id: created.id } },
      { service },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("document not found");
  });

  it("rejects an upload without a tenant_id field", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1])], "x.bin"));
    form.set("document_type", "maintenance_log");
    const res = await handleAttachmentUpload(uploadRequest(form), { service });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/tenant_id/);
  });

  it("rejects an unknown document_type shape", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1])], "x.bin"));
    form.set("tenant_id", tenantA);
    form.set("document_type", "Maintenance Log");
    const res = await handleAttachmentUpload(uploadRequest(form), { service });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/document_type/);
  });

  it("rejects an empty file", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(0)], "empty.bin"));
    form.set("tenant_id", tenantA);
    form.set("document_type", "maintenance_log");
    const res = await handleAttachmentUpload(uploadRequest(form), { service });
    expect(res.status).toBe(400);
  });

  it("retrieve requires a tenant_id query parameter", async () => {
    const res = await handleAttachmentRetrieve(
      new Request(
        `https://example.test/api/attachments/00000000-0000-0000-0000-000000000001`,
        { method: "GET" },
      ),
      { params: { id: "00000000-0000-0000-0000-000000000001" } },
      { service },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/tenant_id/);
  });
});
