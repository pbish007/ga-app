-- 0002_create_accounts.sql
-- Epic A / story A1.1 — accounts foundation (PMB-27).
-- Source: spec Rev. 3 §4 Epic A, §6 ("Do This Now" — credentials row).
--
-- Tables:
--   organizations             — the tenant (school / club / shop / owner)
--   users                     — global identity; passwords set by the user only
--   organization_memberships  — user × tenant join, with role
--   invitations               — email-invite tokens (hash-only at rest)
--   email_outbox              — durable mail queue; real provider plugs in later
--
-- Tenant-scoped tables (memberships, invitations, outbox) have RLS enabled
-- with FORCE. The actual `USING / WITH CHECK` policies land in
-- migration 0003 (story A1.2) alongside the `tenant_app` role grants and
-- query-layer enforcement test. Until 0003 lands, the only paths that read
-- these tables are the migration itself (superuser) and the A1.1 unit
-- tests (also superuser via pglite default) — which is the intended
-- "fail closed for non-superusers" posture for the brief window.

-- ---------------------------------------------------------------------------
-- organizations (tenants)
-- ---------------------------------------------------------------------------

CREATE TABLE organizations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  org_type           text NOT NULL,
  default_regime_id  uuid NOT NULL REFERENCES regimes(id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_org_type_check
    CHECK (org_type IN ('school', 'club', 'shop', 'owner'))
);

CREATE INDEX organizations_default_regime_idx
  ON organizations (default_regime_id);

-- ---------------------------------------------------------------------------
-- users (global identity)
--
-- password_hash is nullable because invited users have no password until
-- they accept the invitation. Spec §4 Epic A: "the system never sets
-- credentials on a user's behalf."
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL,
  password_hash       text,
  email_verified_at   timestamptz,
  password_changed_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_lower_unique ON users (lower(email));

-- ---------------------------------------------------------------------------
-- organization_memberships
-- ---------------------------------------------------------------------------

CREATE TABLE organization_memberships (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_memberships_role_check
    CHECK (role IN ('admin', 'manager', 'mechanic', 'pilot', 'read_only')),
  CONSTRAINT organization_memberships_tenant_user_unique
    UNIQUE (tenant_id, user_id)
);

CREATE INDEX organization_memberships_user_idx
  ON organization_memberships (user_id);

ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- invitations
--
-- token_hash holds sha256(raw_token) as lowercase hex. The raw token is
-- returned exactly once by the InviteService at create time, so it can
-- be embedded in the invite email link. The database never stores it.
-- ---------------------------------------------------------------------------

CREATE TABLE invitations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email               text NOT NULL,
  role                text NOT NULL,
  invited_by_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_hash          text NOT NULL,
  expires_at          timestamptz NOT NULL,
  accepted_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitations_role_check
    CHECK (role IN ('admin', 'manager', 'mechanic', 'pilot', 'read_only'))
);

CREATE UNIQUE INDEX invitations_token_hash_unique ON invitations (token_hash);
CREATE INDEX invitations_tenant_email_idx ON invitations (tenant_id, lower(email));

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- email_outbox
--
-- A durable queue. Real SMTP / API provider integration is a follow-on
-- ticket (V1). For MVP, OutboxMailer enqueues here and a future worker
-- drains it. tenant_id is nullable because some system mail (e.g. a
-- platform notice) is not tenant-scoped.
-- ---------------------------------------------------------------------------

CREATE TABLE email_outbox (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid REFERENCES organizations(id) ON DELETE SET NULL,
  recipient_email   text NOT NULL,
  subject           text NOT NULL,
  body_text         text NOT NULL,
  body_html         text,
  status            text NOT NULL DEFAULT 'pending',
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  sent_at           timestamptz,
  CONSTRAINT email_outbox_status_check
    CHECK (status IN ('pending', 'sent', 'failed'))
);

CREATE INDEX email_outbox_status_idx ON email_outbox (status) WHERE status = 'pending';

ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_outbox FORCE ROW LEVEL SECURITY;
