-- 0028_grant_tenant_app_email.sql
-- Epic G / PMB-172 — unbreak credentials admin pages.
--
-- Migration 0027 added admin pages that list team members with their
-- email column inside `runAsTenantOnProductionDb` (role = `tenant_app`):
--   apps/web/app/orgs/[tenantId]/settings/credentials/page.tsx
--   apps/web/app/orgs/[tenantId]/settings/credentials/[userId]/page.tsx
-- Migration 0016 granted `tenant_app` SELECT on `users.id` only — by
-- design, so the password hash and verification timestamps stay
-- unreadable to tenant code. Reading `users.email` now 500s with
--   ERROR 42501: permission denied for column "email" of relation "users"
--
-- Email is the canonical display identity for a member (the admin
-- credentials list is keyed by it) and there is no per-tenant email
-- concept — a user has one global email. Extend the column-level grant
-- to cover email; password_hash and verification fields remain hidden.
-- Idempotent: re-granting an existing column privilege is a no-op.

GRANT SELECT (email) ON users TO tenant_app;
