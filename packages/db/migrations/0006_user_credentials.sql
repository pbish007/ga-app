-- 0006_user_credentials.sql
-- Epic A / story A2.3 — credential-gated sign-off precondition (PMB-34).
-- Source: spec Rev. 3 §3.4, §4 Epic A (mechanic AC), §6 (A2/A3 seam —
-- credential types are data-driven, not a hardcoded enum).
--
-- Holds the credentials a user has been issued under a given regime.
-- Each row references `regime_credential_types`, so whether a credential
-- authorizes sign-off is a property of the *credential type row*
-- (`authorizes_signoff`), never a switch on a code string.
--
-- Tenant-agnostic: credentials follow the person, not the org. An A&P
-- mechanic who works at two shops has one credential row, not two. The
-- sign-off check (A2.3) reads this table joined with
-- `regime_credential_types` and the user's session — it does not require
-- a tenant context.
--
-- The issue body originally numbered this migration 0005; it ships as
-- 0006 because A2.1 (PMB-32, app_roles) already shipped as 0005. The
-- migration sequence is append-only, so the body's numbering drifts but
-- the *intent* — fifth child of [PMB-10] — is preserved.

CREATE TABLE user_credentials (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  regime_credential_type_id  uuid NOT NULL REFERENCES regime_credential_types(id) ON DELETE RESTRICT,
  certificate_number         text,
  issued_on                  date NOT NULL,
  expires_on                 date,
  revoked_at                 timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- Hot path: "does this user hold an active credential of type X?".
-- Partial on `revoked_at IS NULL` so the index stays small as revoked
-- rows accumulate over time.
CREATE INDEX user_credentials_active_idx
  ON user_credentials (user_id, regime_credential_type_id)
  WHERE revoked_at IS NULL;

-- tenant_app reads this table when checking sign-off authority in a
-- tenant-scoped request (`requireSignoff`). The table itself is not
-- tenant-scoped — credentials follow the person — so no RLS policy is
-- needed; the GRANT below is the only access the application role has.
GRANT SELECT, INSERT, UPDATE, DELETE ON user_credentials TO tenant_app;
