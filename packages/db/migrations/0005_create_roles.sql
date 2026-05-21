-- 0005_create_roles.sql
-- Epic A / story A2.1 — roles & permissions matrix (PMB-32).
-- Source: spec Rev. 3 §4 Epic A; PMB-10 epic.
--
-- Promote the free-text role enum on memberships into a referential
-- permissions matrix:
--
--   app_roles            — canonical role codes (admin/manager/mechanic/pilot/read_only)
--   app_permissions      — canonical permission codes (aircraft.read, …)
--   app_role_permissions — many-to-many join, seeded with the initial matrix
--
-- After this migration, organization_memberships.role and invitations.role
-- are foreign keys onto app_roles(code). The old free-text CHECK constraints
-- from 0002 are dropped — the FK is the authoritative gate.
--
-- The matrix here is the *initial* matrix per the issue. Mechanic.signoff.*
-- is gated separately at the application layer by credential possession
-- and currency (A2.3). The matrix says the role MAY perform a sign-off;
-- the credential check at write-time decides whether this user MAY today.
--
-- The issue body originally called this migration 0004_create_roles.sql; it
-- ships as 0005 because A1.2 (PMB-31, tenant RLS) already took 0004 and the
-- migration sequence is append-only.

-- ---------------------------------------------------------------------------
-- app_roles
-- ---------------------------------------------------------------------------

CREATE TABLE app_roles (
  code         text PRIMARY KEY,
  name         text NOT NULL,
  description  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_roles_code_check
    CHECK (code IN ('admin', 'manager', 'mechanic', 'pilot', 'read_only'))
);

INSERT INTO app_roles (code, name, description) VALUES
  ('admin',     'Administrator', 'Full access to organization data and user management.'),
  ('manager',   'Manager',       'Day-to-day operations: aircraft, inspections, and team membership.'),
  ('mechanic',  'Mechanic',      'Aircraft and inspection writes; may create sign-offs gated by credential.'),
  ('pilot',     'Pilot',         'Read access to aircraft, inspections, and sign-offs.'),
  ('read_only', 'Read Only',     'Read-only access across the organization.');

-- ---------------------------------------------------------------------------
-- app_permissions
--
-- Permission codes use a `<resource>.<action>` convention so future codes
-- (component.read, directive.write, …) slot in without churn. The check
-- constraint pins the *initial* set; new codes ship via follow-on migrations.
-- ---------------------------------------------------------------------------

CREATE TABLE app_permissions (
  code         text PRIMARY KEY,
  description  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO app_permissions (code, description) VALUES
  ('aircraft.read',     'View aircraft records for the organization.'),
  ('aircraft.write',    'Create or update aircraft records.'),
  ('inspection.read',   'View inspection programs and due/overdue status.'),
  ('inspection.write',  'Create or update inspection records.'),
  ('signoff.create',    'Author maintenance return-to-service sign-offs (credential-gated).'),
  ('signoff.read',      'View maintenance sign-offs.'),
  ('org.manage_users',  'Invite, remove, and change roles for users in the organization.');

-- ---------------------------------------------------------------------------
-- app_role_permissions
-- ---------------------------------------------------------------------------

CREATE TABLE app_role_permissions (
  role_code        text NOT NULL REFERENCES app_roles(code) ON DELETE CASCADE,
  permission_code  text NOT NULL REFERENCES app_permissions(code) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_code, permission_code)
);

-- admin — all permissions
INSERT INTO app_role_permissions (role_code, permission_code)
  SELECT 'admin', code FROM app_permissions;

-- manager — all reads + aircraft.write, inspection.write, org.manage_users
INSERT INTO app_role_permissions (role_code, permission_code) VALUES
  ('manager', 'aircraft.read'),
  ('manager', 'aircraft.write'),
  ('manager', 'inspection.read'),
  ('manager', 'inspection.write'),
  ('manager', 'signoff.read'),
  ('manager', 'org.manage_users');

-- mechanic — all reads + aircraft.write, inspection.write, signoff.create, signoff.read
--   (signoff.create still gated by credential at write-time — A2.3.)
INSERT INTO app_role_permissions (role_code, permission_code) VALUES
  ('mechanic', 'aircraft.read'),
  ('mechanic', 'aircraft.write'),
  ('mechanic', 'inspection.read'),
  ('mechanic', 'inspection.write'),
  ('mechanic', 'signoff.create'),
  ('mechanic', 'signoff.read');

-- pilot — aircraft.read, inspection.read, signoff.read
INSERT INTO app_role_permissions (role_code, permission_code) VALUES
  ('pilot', 'aircraft.read'),
  ('pilot', 'inspection.read'),
  ('pilot', 'signoff.read');

-- read_only — every *.read permission
INSERT INTO app_role_permissions (role_code, permission_code)
  SELECT 'read_only', code FROM app_permissions WHERE code LIKE '%.read';

-- ---------------------------------------------------------------------------
-- organization_memberships.role → app_roles.code
-- invitations.role             → app_roles.code
--
-- Drop the free-text CHECK constraints in favour of a real foreign key.
-- The seed above already covers every code the CHECK allowed, so no
-- existing rows are invalidated.
-- ---------------------------------------------------------------------------

ALTER TABLE organization_memberships
  DROP CONSTRAINT organization_memberships_role_check;

ALTER TABLE organization_memberships
  ADD CONSTRAINT organization_memberships_role_fk
  FOREIGN KEY (role) REFERENCES app_roles(code) ON DELETE RESTRICT;

ALTER TABLE invitations
  DROP CONSTRAINT invitations_role_check;

ALTER TABLE invitations
  ADD CONSTRAINT invitations_role_fk
  FOREIGN KEY (role) REFERENCES app_roles(code) ON DELETE RESTRICT;

-- These reference tables are global (not tenant-scoped), so no RLS or
-- tenant_app grant is required — they're readable from the same
-- connection that runs migrations. Tenant_app reads the matrix via a
-- read-only GRANT below so the app can load it at startup.

GRANT SELECT ON app_roles            TO tenant_app;
GRANT SELECT ON app_permissions      TO tenant_app;
GRANT SELECT ON app_role_permissions TO tenant_app;
