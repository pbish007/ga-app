import { createHash, randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import { schema as dbSchema } from "@ga/db";
import type { Document } from "@ga/db";

import type { DocumentsDb } from "./db.js";
import type { BlobStorageDriver } from "./driver.js";
import { buildObjectKey } from "./object-key.js";

const { documents } = dbSchema;

export class DocumentNotFoundError extends Error {
  constructor(public readonly documentId: string) {
    super(`document ${documentId} not found`);
    this.name = "DocumentNotFoundError";
  }
}

export class CrossTenantDocumentAccessError extends Error {
  constructor(
    public readonly documentId: string,
    public readonly attemptedTenantId: string,
  ) {
    super(
      `document ${documentId} is not visible to tenant ${attemptedTenantId}`,
    );
    this.name = "CrossTenantDocumentAccessError";
  }
}

export interface UploadDocumentInput {
  tenantId: string;
  documentType: string;
  originalFilename: string;
  contentType: string;
  body: Uint8Array;
  retentionPeriodDays?: number | null;
  uploadedByUserId?: string | null;
}

export interface UploadDocumentResult {
  document: Document;
}

export interface RetrievedDocument {
  document: Document;
  body: Uint8Array;
}

/**
 * Service facade for tenant-scoped attachment storage.
 *
 * Combines the documents row insert with the blob-driver `put`/`get`,
 * computes the sha256-hex on the way in (matches V1's tamper-evident
 * audit-trail story in F4), and enforces the tenant-id check on every
 * retrieval. Auth-derived `tenant_id` is the caller's responsibility —
 * we never trust a request-body field as the security boundary.
 */
export class DocumentsService {
  constructor(
    private readonly db: DocumentsDb,
    private readonly driver: BlobStorageDriver,
    private readonly providerName:
      | "vercel_blob"
      | "memory" = "vercel_blob",
  ) {}

  async upload(input: UploadDocumentInput): Promise<UploadDocumentResult> {
    const documentId = randomUUID();
    const sha256Hex = createHash("sha256").update(input.body).digest("hex");
    const objectKey = buildObjectKey({
      tenantId: input.tenantId,
      documentType: input.documentType,
      documentId,
      originalFilename: input.originalFilename,
    });

    const putResult = await this.driver.put({
      key: objectKey,
      body: input.body,
      contentType: input.contentType,
      originalFilename: input.originalFilename,
    });

    const [row] = await this.db
      .insert(documents)
      .values({
        id: documentId,
        tenantId: input.tenantId,
        documentType: input.documentType,
        objectKey,
        storageProvider: this.providerName,
        storageUrl: putResult.url,
        originalFilename: input.originalFilename,
        contentType: input.contentType,
        byteSize: input.body.byteLength,
        sha256Hex,
        retentionPeriodDays: input.retentionPeriodDays ?? null,
        uploadedByUserId: input.uploadedByUserId ?? null,
      })
      .returning();
    if (!row) {
      // Compensate: a row insert failure after a successful blob put
      // would leave an orphan blob. Best-effort delete; if delete also
      // fails we still surface the original error.
      try {
        await this.driver.delete({ key: objectKey, url: putResult.url });
      } catch {
        // swallow — surface the row error
      }
      throw new Error("failed to insert document row");
    }
    return { document: row };
  }

  async retrieve(input: {
    documentId: string;
    tenantId: string;
  }): Promise<RetrievedDocument> {
    const rows = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.id, input.documentId),
          eq(documents.tenantId, input.tenantId),
          isNull(documents.deletedAt),
        ),
      );
    const row = rows[0];
    if (!row) {
      // Distinguish "wrong tenant" from "truly absent" so we can return
      // a uniform 404 to clients but log the cross-tenant attempt
      // separately. The look-up below is the same shape minus the tenant
      // predicate.
      const anyRows = await this.db
        .select({ id: documents.id, tenantId: documents.tenantId })
        .from(documents)
        .where(eq(documents.id, input.documentId));
      if (anyRows[0] && anyRows[0].tenantId !== input.tenantId) {
        throw new CrossTenantDocumentAccessError(
          input.documentId,
          input.tenantId,
        );
      }
      throw new DocumentNotFoundError(input.documentId);
    }

    const body = await this.driver.get({
      key: row.objectKey,
      url: row.storageUrl,
    });
    return { document: row, body };
  }
}
