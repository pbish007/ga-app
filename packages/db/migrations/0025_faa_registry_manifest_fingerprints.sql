-- FAA Registry: extend snapshot_manifest with per-file byte length + sha256 (PMB-105 R1).
-- Lives in the FAA Supabase project (FAA_DATABASE_URL), NOT the tenant DB.
-- Acceptance criteria for PMB-105 require sha256 in the manifest so a re-download
-- can be byte-compared against the recorded fingerprint.

alter table faa_registry.snapshot_manifest
  add column if not exists master_bytes   bigint,
  add column if not exists master_sha256  text,
  add column if not exists acftref_bytes  bigint,
  add column if not exists acftref_sha256 text,
  add column if not exists engine_bytes   bigint,
  add column if not exists engine_sha256  text,
  add column if not exists dealer_bytes   bigint,
  add column if not exists dealer_sha256  text,
  add column if not exists dereg_bytes    bigint,
  add column if not exists dereg_sha256   text,
  add column if not exists acftref_count  integer,
  add column if not exists engine_count   integer,
  add column if not exists dealer_count   integer;
