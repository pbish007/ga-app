import { schema as dbSchema } from "@ga/db";
import type {
  AppPermissionCode,
  AppRoleCode,
  OrganizationMembership,
} from "@ga/db";

import type { AccountsDb } from "./db.js";

const { appRolePermissions } = dbSchema;

/** A role code from the `app_roles` table. */
export type Role = AppRoleCode;

/** A permission code from the `app_permissions` table. */
export type Permission = AppPermissionCode;

/**
 * Frozen role → permissions lookup. Construct once at app start via
 * `loadPermissionsMatrix(db)`; pass to `attachPermissions` to resolve a
 * membership's permission set.
 */
export class PermissionsMatrix {
  private constructor(
    private readonly byRole: ReadonlyMap<Role, ReadonlySet<Permission>>,
  ) {}

  static fromEntries(
    entries: Iterable<readonly [Role, Iterable<Permission>]>,
  ): PermissionsMatrix {
    const map = new Map<Role, ReadonlySet<Permission>>();
    for (const [role, perms] of entries) {
      map.set(role, new Set(perms));
    }
    return new PermissionsMatrix(map);
  }

  /**
   * Permissions for a role, or an empty set if the role is unknown.
   * Returning an empty set rather than throwing preserves the
   * deny-by-default property of `hasPermission`.
   */
  permissionsFor(role: Role): ReadonlySet<Permission> {
    return this.byRole.get(role) ?? EMPTY_PERMISSIONS;
  }

  roles(): readonly Role[] {
    return [...this.byRole.keys()];
  }
}

const EMPTY_PERMISSIONS: ReadonlySet<Permission> = new Set();

/**
 * Load the role → permissions matrix from the database. Intended to be
 * called once at application start; the result is then attached to every
 * resolved membership.
 */
export async function loadPermissionsMatrix(
  db: AccountsDb,
): Promise<PermissionsMatrix> {
  const rows = await db.select().from(appRolePermissions);
  const grouped = new Map<Role, Set<Permission>>();
  for (const row of rows) {
    const role = row.roleCode as Role;
    const perm = row.permissionCode as Permission;
    let bucket = grouped.get(role);
    if (!bucket) {
      bucket = new Set<Permission>();
      grouped.set(role, bucket);
    }
    bucket.add(perm);
  }
  return PermissionsMatrix.fromEntries(grouped);
}

/**
 * A membership with its resolved permission set frozen onto it. The
 * `hasPermission` helper consumes this shape so it stays pure (no DB,
 * no closure-captured state).
 */
export interface MembershipWithPermissions extends OrganizationMembership {
  permissions: ReadonlySet<Permission>;
}

/**
 * Resolve a membership's permissions through the matrix. Pure: no DB,
 * no I/O. Unknown roles yield an empty set so `hasPermission` denies.
 */
export function attachPermissions(
  membership: OrganizationMembership,
  matrix: PermissionsMatrix,
): MembershipWithPermissions {
  return {
    ...membership,
    permissions: matrix.permissionsFor(membership.role as Role),
  };
}

/**
 * Deny-by-default permission check. Pure: depends only on the input
 * membership and permission code. Callers MUST resolve the matrix once
 * at app start and attach it to memberships before calling — see
 * `loadPermissionsMatrix` and `attachPermissions`.
 *
 * Unknown role codes and unknown permission codes both return `false`.
 */
export function hasPermission(
  membership: MembershipWithPermissions,
  permission: Permission,
): boolean {
  return membership.permissions.has(permission);
}
