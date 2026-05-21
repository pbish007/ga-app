import { NextResponse } from "next/server";

import type {
  CredentialService,
  MembershipWithPermissions,
} from "@ga/accounts";

/**
 * Only the mechanic role can ever satisfy the sign-off precondition.
 * Spec §4 Epic A acceptance criterion: pilot/admin/manager/read_only
 * never qualify, even with a valid credential. The A2.1 matrix grants
 * `signoff.create` to mechanic; this guard is the data-plane half of the
 * same gate.
 */
const SIGNOFF_ROLE = "mechanic" as const;

export interface RequireSignoffDeps {
  credentials: CredentialService;
}

export interface RequireSignoffInput {
  userId: string;
  membership: MembershipWithPermissions;
  /**
   * Regime the sign-off must satisfy — typically the aircraft's
   * `regime_id`. Callers MUST NOT default this to the FAA — pass the
   * aircraft's regime explicitly so cross-regime sign-off attempts fail
   * closed.
   */
  regimeId: string;
  now?: Date;
}

/**
 * Returns 403 unless the membership role is `mechanic` AND the user
 * holds a non-revoked, non-expired credential under the supplied regime
 * whose credential-type row sets `authorizes_signoff = true`. The
 * credential check is data-driven via `CredentialService.canSignOff`
 * (which joins `regime_credential_types`) — there is no code-string
 * switch here.
 *
 * Sign-off endpoints attach this guard *after* `withRequest` has
 * already authenticated the user and resolved the membership and
 * tenant context.
 *
 * Returns `null` when the caller is authorized; the route handler then
 * proceeds with the action. Returns a 403 `Response` otherwise — the
 * route handler MUST return that response unchanged.
 */
export async function requireSignoff(
  input: RequireSignoffInput,
  deps: RequireSignoffDeps,
): Promise<Response | null> {
  if (input.membership.role !== SIGNOFF_ROLE) {
    return NextResponse.json(
      { error: "sign-off requires the mechanic role" },
      { status: 403 },
    );
  }
  const ok = await deps.credentials.canSignOff(input.userId, {
    regimeId: input.regimeId,
    now: input.now,
  });
  if (!ok) {
    return NextResponse.json(
      { error: "no current credential authorizes this sign-off" },
      { status: 403 },
    );
  }
  return null;
}
