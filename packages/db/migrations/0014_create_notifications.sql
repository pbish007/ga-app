-- 0014_create_notifications.sql
-- Epic H / story H1 — Notifications (PMB-17).
-- Source: spec Rev. 3 §4 Epic H.
--
-- Two tables:
--
--   * notification_preferences — per-(tenant,user) settings. Email lead
--     time in days is configurable; email delivery can be muted; in-app
--     alerts are NOT opt-out (spec §4 Epic H AC) so there is no in-app
--     toggle column.
--
--   * notifications — the durable fan-out ledger. One row per
--     (tenant, user, aircraft, program, level, cycle_key). Idempotent:
--     re-running the sweep cannot produce duplicate rows or duplicate
--     emails. `cycle_key` rolls forward when the inspection is signed
--     off (lastCompliedAt advances), so the next cycle can notify again.
--
-- Tenant-scoped with RLS, like every other tenant table.
--
-- Email side-channel: when a row is created with deliver_email = true,
-- the sweep enqueues a corresponding row in email_outbox in the SAME
-- transaction and stores its id in email_outbox_id. The unique index on
-- the notification row guarantees the enqueue happens at most once.

-- ---------------------------------------------------------------------------
-- notification_preferences
-- ---------------------------------------------------------------------------

CREATE TABLE notification_preferences (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id                     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Default lead time for "due soon" email alerts in calendar days.
  -- The compliance engine separately determines whether an item is
  -- mathematically due_soon vs. overdue — this is purely about WHEN to
  -- start emailing the user about a due_soon item.
  email_lead_time_days        integer NOT NULL DEFAULT 14,
  email_enabled               boolean NOT NULL DEFAULT true,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_preferences_tenant_user_unique
    UNIQUE (tenant_id, user_id),
  CONSTRAINT notification_preferences_lead_time_positive
    CHECK (email_lead_time_days >= 0 AND email_lead_time_days <= 365)
);

CREATE INDEX notification_preferences_tenant_idx
  ON notification_preferences (tenant_id);
CREATE INDEX notification_preferences_user_idx
  ON notification_preferences (user_id);

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;

CREATE POLICY app_isolation ON notification_preferences
  USING      (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON notification_preferences TO tenant_app;

-- ---------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------

CREATE TABLE notifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  aircraft_id         uuid NOT NULL REFERENCES aircraft(id) ON DELETE CASCADE,
  program_id          uuid NOT NULL REFERENCES regime_inspection_program_templates(id) ON DELETE RESTRICT,
  -- Severity at emission time. The engine status that triggered this row.
  level               text NOT NULL,
  -- Frozen at emission so the in-app surface can present the message
  -- without re-running the engine. Operational language only — no
  -- regulatory text (F2 seam).
  subject             text NOT NULL,
  body                text NOT NULL,
  -- A string that changes when the inspection rolls forward, so the same
  -- (user, aircraft, program, level) pair can re-notify on the next cycle
  -- without violating the unique index below.
  cycle_key           text NOT NULL,
  -- Whether the user had email enabled at fan-out time.
  deliver_email       boolean NOT NULL,
  -- Link to the queued email row (null if email was disabled).
  email_outbox_id     uuid REFERENCES email_outbox(id) ON DELETE SET NULL,
  -- In-app surface bookkeeping.
  seen_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_level_check
    CHECK (level IN ('due_soon', 'overdue'))
);

-- Idempotency: a sweep that re-emits the same logical event is a no-op.
CREATE UNIQUE INDEX notifications_idempotency_unique
  ON notifications (tenant_id, user_id, aircraft_id, program_id, level, cycle_key);

CREATE INDEX notifications_tenant_idx        ON notifications (tenant_id);
CREATE INDEX notifications_user_idx          ON notifications (tenant_id, user_id);
CREATE INDEX notifications_user_unseen_idx
  ON notifications (tenant_id, user_id, created_at DESC)
  WHERE seen_at IS NULL;
CREATE INDEX notifications_aircraft_idx      ON notifications (aircraft_id);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;

CREATE POLICY app_isolation ON notifications
  USING      (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO tenant_app;
