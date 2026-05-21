-- 0003_create_documents.sql
-- Epic J / story J2.1 — generic document/attachment store (PMB-20).
-- Source: spec Rev. 3 §3.5 (records export is V1-first-class), §6 B4/G2/J4
-- (generic entity naming; `document_type` is an attribute, not a table-per-kind;
--  retention period is a per-record column, not a table-per-document-type).
--
-- Why one generic table rather than maintenance_logs / inspection_records /
-- ad_compliance_documents / ... :
--
--   * §6 J4: retention horizon varies per document kind (1 year vs lifetime),
--     so retention must live on the record. With a table-per-kind we'd have
--     to migrate the column shape every time a new regime adds a new kind.
--   * §6 G2: "document type" is a regime-owned data attribute that maps to
--     the regime's retention rules; behavior is data-driven.
--   * §3.5: V1's records export streams every attachment regardless of kind;
--     a single join target keeps the export side trivial.
--
-- The `object_key` follows the J2.1 convention:
--     tenants/{tenant_id}/{document_type}/{document_id}/{slug}
-- The leading `tenants/{tenant_id}/...` segment is non-negotiable: it
-- bounds blast radius if an object-store IAM bug leaks individual blobs,
-- and it makes a full per-tenant export equivalent to a prefix scan.
--
-- `storage_url` holds the provider-issued URL. Vercel Blob appends a
-- random suffix to the pathname on `put()`, so the URL is not derivable
-- from the object key alone; we persist what the SDK gave us. The URL
-- never leaves the backend in J2.1 — the retrieval endpoint streams the
-- bytes through our server so the random-suffix URL stays private. J2.2
-- (PMB-23) introduces short-lived signed URLs for direct browser
-- downloads of large files.

CREATE TABLE documents (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  document_type          text NOT NULL,
  object_key             text NOT NULL,
  storage_provider       text NOT NULL DEFAULT 'vercel_blob',
  storage_url            text NOT NULL,
  original_filename      text NOT NULL,
  content_type           text NOT NULL,
  byte_size              bigint NOT NULL,
  sha256_hex             text NOT NULL,
  retention_period_days  integer,
  uploaded_by_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,
  CONSTRAINT documents_byte_size_nonneg
    CHECK (byte_size >= 0),
  CONSTRAINT documents_retention_nonneg
    CHECK (retention_period_days IS NULL OR retention_period_days >= 0),
  CONSTRAINT documents_object_key_tenant_prefix
    CHECK (object_key LIKE 'tenants/' || tenant_id::text || '/%')
);

CREATE UNIQUE INDEX documents_object_key_unique
  ON documents (object_key);

CREATE INDEX documents_tenant_type_idx
  ON documents (tenant_id, document_type);

CREATE INDEX documents_tenant_created_idx
  ON documents (tenant_id, created_at DESC);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;

-- The actual `USING` / `WITH CHECK` policies and the `tenant_app` role
-- grant land alongside Epic A's RLS rollout (see PMB-10 / A1.2). Until
-- then `documents` is fail-closed for non-superusers, matching the
-- `organization_memberships` / `invitations` / `email_outbox` posture
-- introduced in 0002.
