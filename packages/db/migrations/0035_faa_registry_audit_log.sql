-- FAA Registry: faa_registry_audit_log (PMB-110 PM addendum, CTO refinement).
-- Lives in the FAA Supabase project (FAA_DATABASE_URL), NOT the tenant DB.
--
-- Why: maintenance-app reads of faa_registry.* go through a service-role
-- connection (no per-tenant RLS on the FAA DB). Without an application-layer
-- audit trail we cannot answer "who looked up which N-number when" after
-- the fact, which is the only way to enforce least-privilege post-hoc.
--
-- Per CTO refinement: include request_id so audit rows correlate to the
-- originating HTTP request — cheap to add now, painful to backfill later.
--
-- Retention: 90 days. NOT a regulatory floor (see CTO comment on PMB-110:
-- consuming the FAA public Registry is not 14 CFR Part 91 recordkeeping);
-- it's a discretionary security/observability window we can lower or raise
-- without touching a regulation.
--
-- This migration is additive and idempotent.

create table if not exists faa_registry.faa_registry_audit_log (
  id                bigserial primary key,
  accessed_at       timestamptz not null default now(),
  -- Originating tenant + principal (service role usually; backfilled by
  -- application). NULL principal is allowed for system probes/health checks.
  tenant_id         uuid,
  principal         text,
  -- Correlate to the originating HTTP request. Logged by the request
  -- middleware in apps/web; copied into every FAA read it issues.
  request_id        text,
  -- Subject of the lookup. n_number nullable because some reads are
  -- bulk / search queries that don't pin a single tail number.
  n_number          text,
  -- Columns returned by the query so we can prove minimality post-hoc.
  columns_returned  text[],
  -- Free-form context (query string, search predicate). Stored as jsonb so
  -- callers can attach minimal structured context without a schema change.
  metadata          jsonb
);

-- Primary query pattern from PMB-103 addendum:
--   "show me reads against N-number X in the last 30 days"
create index if not exists faa_registry_audit_log_n_number_accessed_at
  on faa_registry.faa_registry_audit_log (n_number, accessed_at desc)
  where n_number is not null;

-- Secondary: "show me every FAA lookup that the request which mutated
-- work-order Y performed" — CTO's request_id correlation pattern.
create index if not exists faa_registry_audit_log_request_id
  on faa_registry.faa_registry_audit_log (request_id)
  where request_id is not null;

-- Retention housekeeping. Manual today (cron / runbook); the comment carries
-- the policy so a future TTL task does not need to rediscover it.
comment on table faa_registry.faa_registry_audit_log is
  'PMB-110 audit log for service-role reads of faa_registry.*. '
  'Retention: 90 days (discretionary, not a regulatory floor). '
  'Purge via runbook: docs/ops/faa-registry-runbook.md#audit-log-retention.';
