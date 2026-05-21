import { NextResponse } from "next/server";

import {
  CrossTenantDocumentAccessError,
  DocumentNotFoundError,
  InvalidObjectKeyInputError,
  SignedUrlExpiredError,
  SignedUrlInvalidError,
  SIGNED_URL_DEFAULT_TTL_MS,
  createSignedDownloadToken,
  verifySignedDownloadToken,
  type DocumentsService,
} from "@ga/storage";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOCUMENT_TYPE_RE = /^[a-z0-9][a-z0-9_]*$/;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface AttachmentsHandlerDeps {
  service: DocumentsService;
  signingSecret?: string;
}

function serializeDocument(d: {
  id: string;
  tenantId: string;
  documentType: string;
  objectKey: string;
  originalFilename: string;
  contentType: string;
  byteSize: number;
  sha256Hex: string;
  retentionPeriodDays: number | null;
  createdAt: Date;
}) {
  return {
    id: d.id,
    tenant_id: d.tenantId,
    document_type: d.documentType,
    object_key: d.objectKey,
    original_filename: d.originalFilename,
    content_type: d.contentType,
    byte_size: d.byteSize,
    sha256_hex: d.sha256Hex,
    retention_period_days: d.retentionPeriodDays,
    created_at: d.createdAt.toISOString(),
  };
}

/**
 * POST /api/attachments — multipart/form-data upload.
 *
 * Required form fields:
 *   - `file`              : the file
 *   - `tenant_id`         : owning tenant (UUID)
 *   - `document_type`     : regime-catalogued kind (e.g. `maintenance_log`)
 *
 * Optional:
 *   - `retention_period_days` : integer; falls back to the regime's
 *                               retention rule when joined for export.
 *   - `uploaded_by_user_id`   : UUID of the acting user. Once Epic A
 *                               lands, the route will derive this from
 *                               the session instead of trusting the form.
 *
 * The 25 MB cap is an MVP guard; the real platform cap is regime- and
 * document-type-aware and will live on the regime's `documents` policy
 * table when V1 lands.
 */
export async function handleAttachmentUpload(
  request: Request,
  deps: AttachmentsHandlerDeps,
): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "expected multipart/form-data body" },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "field `file` is required and must be a file upload" },
      { status: 400 },
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error: `file exceeds ${MAX_UPLOAD_BYTES} byte cap (MVP)`,
      },
      { status: 413 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json(
      { error: "uploaded file is empty" },
      { status: 400 },
    );
  }

  const tenantId = (form.get("tenant_id") ?? "").toString().trim().toLowerCase();
  if (!UUID_RE.test(tenantId)) {
    return NextResponse.json(
      { error: "field `tenant_id` must be a canonical UUID" },
      { status: 400 },
    );
  }

  const documentType = (form.get("document_type") ?? "").toString().trim();
  if (!DOCUMENT_TYPE_RE.test(documentType)) {
    return NextResponse.json(
      {
        error:
          "field `document_type` must match /^[a-z0-9][a-z0-9_]*$/",
      },
      { status: 400 },
    );
  }

  const retentionRaw = form.get("retention_period_days");
  let retentionPeriodDays: number | null = null;
  if (retentionRaw !== null && retentionRaw.toString().trim() !== "") {
    const n = Number(retentionRaw);
    if (!Number.isInteger(n) || n < 0) {
      return NextResponse.json(
        {
          error:
            "field `retention_period_days` must be a non-negative integer when present",
        },
        { status: 400 },
      );
    }
    retentionPeriodDays = n;
  }

  const uploadedByUserIdRaw = form.get("uploaded_by_user_id");
  let uploadedByUserId: string | null = null;
  if (uploadedByUserIdRaw !== null) {
    const v = uploadedByUserIdRaw.toString().trim().toLowerCase();
    if (v !== "" && !UUID_RE.test(v)) {
      return NextResponse.json(
        { error: "field `uploaded_by_user_id` must be a canonical UUID" },
        { status: 400 },
      );
    }
    uploadedByUserId = v === "" ? null : v;
  }

  const originalFilename = file.name && file.name.length > 0 ? file.name : "upload";
  const contentType = file.type && file.type.length > 0
    ? file.type
    : "application/octet-stream";

  const body = new Uint8Array(await file.arrayBuffer());

  try {
    const { document } = await deps.service.upload({
      tenantId,
      documentType,
      originalFilename,
      contentType,
      body,
      retentionPeriodDays,
      uploadedByUserId,
    });
    return NextResponse.json(serializeDocument(document), { status: 201 });
  } catch (err) {
    if (err instanceof InvalidObjectKeyInputError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}

/**
 * GET /api/attachments/{id}?tenant_id={uuid}
 *
 * Returns the raw bytes. `Content-Type` reflects the stored content
 * type; `Content-Disposition` includes the original filename so a
 * browser/`curl -OJ` flow writes the user-meaningful name. The
 * `tenant_id` query parameter is mandatory for J2.1 (Epic A's session
 * scope replaces it once that lands; see PMB-10).
 */
export async function handleAttachmentRetrieve(
  request: Request,
  context: { params: { id: string } },
  deps: AttachmentsHandlerDeps,
): Promise<Response> {
  const documentId = context.params.id?.toLowerCase() ?? "";
  if (!UUID_RE.test(documentId)) {
    return NextResponse.json(
      { error: "path parameter `id` must be a canonical UUID" },
      { status: 400 },
    );
  }

  const url = new URL(request.url);
  const tenantId = (url.searchParams.get("tenant_id") ?? "")
    .trim()
    .toLowerCase();
  if (!UUID_RE.test(tenantId)) {
    return NextResponse.json(
      { error: "query parameter `tenant_id` is required and must be a UUID" },
      { status: 400 },
    );
  }

  try {
    const { document, body } = await deps.service.retrieve({
      documentId,
      tenantId,
    });
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": document.contentType,
        "Content-Length": String(document.byteSize),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeRFC5987(
          document.originalFilename,
        )}`,
        "X-Document-Sha256": document.sha256Hex,
      },
    });
  } catch (err) {
    if (err instanceof DocumentNotFoundError) {
      return NextResponse.json({ error: "document not found" }, { status: 404 });
    }
    if (err instanceof CrossTenantDocumentAccessError) {
      // Same response shape as not-found: don't leak the existence of
      // another tenant's document. The server log distinguishes the
      // two cases.
      console.warn(
        `cross-tenant attachment fetch blocked document=${err.documentId} tenant=${err.attemptedTenantId}`,
      );
      return NextResponse.json({ error: "document not found" }, { status: 404 });
    }
    throw err;
  }
}

/**
 * GET /api/attachments/{id}/signed-url?tenant_id={uuid}&ttl_ms={ms}
 *
 * Mints a short-lived signed download token for a document the caller
 * already has access to. The token encodes `{ documentId, tenantId,
 * expiresAt }` signed with HMAC-SHA256 keyed on BLOB_READ_WRITE_TOKEN.
 *
 * Returns `{ signed_url, expires_at }` where `signed_url` is the
 * `GET /api/attachments/download?token=...` path the client redeems.
 *
 * TTL defaults to 5 minutes; pass `ttl_ms` to override (cap: 1 hour).
 * Logs the mint event with tenant_id, attachment_id, and TTL.
 *
 * AC (J2.2):
 *   - Token is invalid after TTL (enforced by `handleAttachmentDownload`).
 *   - Tampered tokens are rejected by signature check.
 *   - Mint is logged with tenant_id, attachment_id, and TTL.
 */
export async function handleAttachmentMintSignedUrl(
  request: Request,
  context: { params: { id: string } },
  deps: AttachmentsHandlerDeps,
): Promise<Response> {
  const documentId = context.params.id?.toLowerCase() ?? "";
  if (!UUID_RE.test(documentId)) {
    return NextResponse.json(
      { error: "path parameter `id` must be a canonical UUID" },
      { status: 400 },
    );
  }

  const url = new URL(request.url);
  const tenantId = (url.searchParams.get("tenant_id") ?? "")
    .trim()
    .toLowerCase();
  if (!UUID_RE.test(tenantId)) {
    return NextResponse.json(
      { error: "query parameter `tenant_id` is required and must be a UUID" },
      { status: 400 },
    );
  }

  const ttlRaw = url.searchParams.get("ttl_ms");
  let ttlMs = SIGNED_URL_DEFAULT_TTL_MS;
  if (ttlRaw !== null && ttlRaw.trim() !== "") {
    const n = Number(ttlRaw);
    if (!Number.isInteger(n) || n <= 0 || n > 60 * 60 * 1000) {
      return NextResponse.json(
        {
          error:
            "query parameter `ttl_ms` must be a positive integer ≤ 3600000",
        },
        { status: 400 },
      );
    }
    ttlMs = n;
  }

  const secret = deps.signingSecret ?? process.env.BLOB_READ_WRITE_TOKEN ?? "";
  if (!secret) {
    return NextResponse.json(
      { error: "server misconfiguration: signing secret is not set" },
      { status: 500 },
    );
  }

  try {
    // Auth check: verify the document exists and belongs to this tenant.
    // Does not fetch blob bytes.
    await deps.service.getDocumentMeta({ documentId, tenantId });
  } catch (err) {
    if (err instanceof DocumentNotFoundError) {
      return NextResponse.json(
        { error: "document not found" },
        { status: 404 },
      );
    }
    if (err instanceof CrossTenantDocumentAccessError) {
      console.warn(
        `cross-tenant signed-url mint blocked document=${err.documentId} tenant=${err.attemptedTenantId}`,
      );
      return NextResponse.json(
        { error: "document not found" },
        { status: 404 },
      );
    }
    throw err;
  }

  const { token, expiresAt } = createSignedDownloadToken(
    secret,
    { documentId, tenantId },
    { ttlMs },
  );

  console.info(
    `signed-url minted attachment_id=${documentId} tenant_id=${tenantId} ttl_ms=${ttlMs} expires_at=${expiresAt.toISOString()}`,
  );

  const downloadUrl = `/api/attachments/download?token=${encodeURIComponent(token)}`;
  return NextResponse.json(
    { signed_url: downloadUrl, expires_at: expiresAt.toISOString() },
    { status: 200 },
  );
}

/**
 * GET /api/attachments/download?token={signedToken}
 *
 * Redeems a signed download token minted by `handleAttachmentMintSignedUrl`.
 * Validates the HMAC signature and expiry, then proxies the blob bytes
 * (same response shape as the direct retrieval endpoint).
 *
 * Returns 401 for expired or invalid tokens so clients can distinguish
 * "token problem" from "document gone" (404).
 */
export async function handleAttachmentDownload(
  request: Request,
  deps: AttachmentsHandlerDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  if (!token) {
    return NextResponse.json(
      { error: "query parameter `token` is required" },
      { status: 400 },
    );
  }

  const secret = deps.signingSecret ?? process.env.BLOB_READ_WRITE_TOKEN ?? "";
  if (!secret) {
    return NextResponse.json(
      { error: "server misconfiguration: signing secret is not set" },
      { status: 500 },
    );
  }

  let payload: { documentId: string; tenantId: string };
  try {
    payload = verifySignedDownloadToken(secret, token);
  } catch (err) {
    if (err instanceof SignedUrlExpiredError) {
      return NextResponse.json(
        { error: "signed download URL has expired" },
        { status: 401 },
      );
    }
    if (err instanceof SignedUrlInvalidError) {
      return NextResponse.json(
        { error: "signed download URL is invalid" },
        { status: 401 },
      );
    }
    throw err;
  }

  try {
    const { document, body } = await deps.service.retrieve({
      documentId: payload.documentId,
      tenantId: payload.tenantId,
    });
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": document.contentType,
        "Content-Length": String(document.byteSize),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeRFC5987(
          document.originalFilename,
        )}`,
        "X-Document-Sha256": document.sha256Hex,
      },
    });
  } catch (err) {
    if (
      err instanceof DocumentNotFoundError ||
      err instanceof CrossTenantDocumentAccessError
    ) {
      return NextResponse.json(
        { error: "document not found" },
        { status: 404 },
      );
    }
    throw err;
  }
}

function encodeRFC5987(value: string): string {
  return encodeURIComponent(value)
    .replace(/['()]/g, escape)
    .replace(/\*/g, "%2A");
}
