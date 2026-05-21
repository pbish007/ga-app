import type { ReactNode } from "react";

import type { MembershipWithPermissions, Permission } from "@ga/accounts";

export interface AuthorizedProps {
  /**
   * The active membership for the current viewer. Resolved server-side
   * (loadSession → loadMembership) and passed down through layouts
   * — never trust a client-supplied membership object.
   */
  membership: Pick<MembershipWithPermissions, "permissions"> | null | undefined;
  /** Permission code required to render `children`. */
  permission: Permission;
  children: ReactNode;
  /** Optional alternative content when the viewer is denied. */
  fallback?: ReactNode;
}

/**
 * Render-time permission gate. This is a **defense-in-depth layer**, not
 * the authoritative check — every protected action must also be enforced
 * by `withRequest` on the API handler. Hiding a button does not protect
 * the endpoint it calls.
 *
 * See `apps/web/lib/auth/withRequest.ts` for the server-side gate.
 */
export function Authorized({
  membership,
  permission,
  children,
  fallback = null,
}: AuthorizedProps) {
  if (!membership || !membership.permissions.has(permission)) {
    return <>{fallback}</>;
  }
  return <>{children}</>;
}
