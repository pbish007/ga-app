import { sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  APP_PERMISSION_CODES,
  APP_ROLE_CODES,
  setupTestSuite,
  type AppPermissionCode,
  type AppRoleCode,
  type TestDb,
} from "@ga/db";

import {
  PermissionsMatrix,
  attachPermissions,
  hasPermission,
  loadPermissionsMatrix,
  type Permission,
} from "../src/index.js";

// Truth table per PMB-32. Edits here are the single source of truth for
// any matrix change; the seed migration must move in lockstep.
const EXPECTED_MATRIX: Record<AppRoleCode, ReadonlyArray<AppPermissionCode>> = {
  admin: [...APP_PERMISSION_CODES],
  manager: [
    "aircraft.read",
    "aircraft.write",
    "inspection.read",
    "inspection.write",
    "signoff.read",
    "org.manage_users",
  ],
  mechanic: [
    "aircraft.read",
    "aircraft.write",
    "inspection.read",
    "inspection.write",
    "signoff.create",
    "signoff.read",
  ],
  pilot: ["aircraft.read", "inspection.read", "signoff.read"],
  read_only: APP_PERMISSION_CODES.filter((c) => c.endsWith(".read")),
};

function syntheticMembership(role: AppRoleCode) {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    tenantId: "00000000-0000-0000-0000-000000000000",
    userId: "00000000-0000-0000-0000-000000000000",
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("A2.1 roles & permissions matrix (PMB-32)", () => {
  describe("seed migration", () => {
    let db: TestDb;
    let reset: () => Promise<void>;
    beforeAll(async () => {
      ({ db, reset } = await setupTestSuite());
    });
    afterEach(async () => {
      await reset();
    });

    it("seeds the matrix exactly as the expected truth table", async () => {
      const matrix = await loadPermissionsMatrix(db);
      for (const role of APP_ROLE_CODES) {
        const got = matrix.permissionsFor(role);
        const expected = new Set<Permission>(EXPECTED_MATRIX[role]);
        expect(
          [...got].sort(),
          `permissions for role=${role}`,
        ).toEqual([...expected].sort());
      }
    });

    it("FKs organization_memberships.role onto app_roles", async () => {
      // Bogus role at the SQL boundary — proves the FK on the membership
      // table is the real gate. (gen_random_uuid for tenant/user is fine;
      // they don't have to resolve — Postgres validates the role FK first
      // alongside the tenant/user FKs and rejects the row.)
      await expect(
        db.execute(
          sql`INSERT INTO organization_memberships (tenant_id, user_id, role) VALUES (gen_random_uuid(), gen_random_uuid(), 'captain')`,
        ),
      ).rejects.toThrow();
    });
  });

  describe("hasPermission (pure helper)", () => {
    let db: TestDb;
    let reset: () => Promise<void>;
    beforeAll(async () => {
      ({ db, reset } = await setupTestSuite());
    });
    afterEach(async () => {
      await reset();
    });

    it("is exhaustive — every (role, permission) pair matches the truth table", async () => {
      const matrix = await loadPermissionsMatrix(db);
      for (const role of APP_ROLE_CODES) {
        const membership = attachPermissions(syntheticMembership(role), matrix);
        const grant = new Set<Permission>(EXPECTED_MATRIX[role]);
        for (const perm of APP_PERMISSION_CODES) {
          expect(
            hasPermission(membership, perm),
            `role=${role} permission=${perm}`,
          ).toBe(grant.has(perm));
        }
      }
    });

    it("denies an unknown role code (deny-by-default)", async () => {
      const matrix = await loadPermissionsMatrix(db);
      const membership = attachPermissions(
        syntheticMembership("captain" as unknown as AppRoleCode),
        matrix,
      );
      for (const perm of APP_PERMISSION_CODES) {
        expect(hasPermission(membership, perm), `unknown role / ${perm}`).toBe(
          false,
        );
      }
    });

    it("denies an unknown permission code (deny-by-default)", async () => {
      const matrix = await loadPermissionsMatrix(db);
      const adminMembership = attachPermissions(
        syntheticMembership("admin"),
        matrix,
      );
      const unknown = "missile.launch" as unknown as Permission;
      expect(hasPermission(adminMembership, unknown)).toBe(false);
    });

    it("denies every permission when the matrix is empty (deny-by-default)", () => {
      const empty = PermissionsMatrix.fromEntries([]);
      const membership = attachPermissions(syntheticMembership("admin"), empty);
      for (const perm of APP_PERMISSION_CODES) {
        expect(hasPermission(membership, perm), `empty matrix / ${perm}`).toBe(
          false,
        );
      }
    });
  });
});
