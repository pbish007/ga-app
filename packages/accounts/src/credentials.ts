import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { schema as dbSchema } from "@ga/db";
import type {
  RegimeCredentialType,
  UserCredential,
  UserCredentialChange,
} from "@ga/db";

import type { AccountsDb } from "./db.js";

const {
  organizationMemberships,
  regimeCredentialTypes,
  userCredentialChanges,
  userCredentials,
} = dbSchema;

export interface AddCredentialInput {
  userId: string;
  regimeCredentialTypeId: string;
  certificateNumber?: string | null;
  ratings?: readonly string[] | null;
  /** ISO-8601 date (YYYY-MM-DD). */
  issuedOn: string;
  /** ISO-8601 date (YYYY-MM-DD). Omit for credentials with no expiry. */
  expiresOn?: string | null;
}

export interface CanSignOffOptions {
  /** Regime id the sign-off must satisfy (e.g. the aircraft's regime). */
  regimeId: string;
  /**
   * Override the "now" clock — used by tests to exercise the expiry edge.
   * In production, defaults to `new Date()`.
   */
  now?: Date;
}

/** Audit-enriched create input. */
export interface CreateCredentialInput {
  /** Tenant the actor is acting on behalf of. Pinned to the audit row. */
  tenantId: string;
  /** Admin user performing the action. Pinned to both the credential row and the audit row. */
  actorUserId: string;
  /** Member of {@link tenantId} the credential belongs to. */
  targetUserId: string;
  regimeCredentialTypeId: string;
  certificateNumber?: string | null;
  ratings?: readonly string[] | null;
  issuedOn: string;
  expiresOn?: string | null;
}

/** Audit-enriched update input. Only fields that should change are present. */
export interface UpdateCredentialInput {
  tenantId: string;
  actorUserId: string;
  credentialId: string;
  certificateNumber?: string | null;
  ratings?: readonly string[] | null;
  issuedOn?: string;
  expiresOn?: string | null;
}

export interface RevokeCredentialInput {
  tenantId: string;
  actorUserId: string;
  credentialId: string;
  at?: Date;
}

/**
 * A current-and-valid credential view used by sign-off surfaces. The
 * `credential_type_code`/`authorizes_signoff` columns come from the
 * data-driven `regime_credential_types` join so the FE can render the
 * credential card without re-querying per credential.
 */
export interface ActiveCredentialView {
  id: string;
  userId: string;
  regimeCredentialTypeId: string;
  credentialTypeCode: string;
  credentialTypeName: string;
  authorizesSignoff: boolean;
  certificateNumber: string | null;
  ratings: string[];
  issuedOn: string;
  expiresOn: string | null;
}

export class CredentialNotInTenantError extends Error {
  constructor(public readonly targetUserId: string, public readonly tenantId: string) {
    super(
      `user ${targetUserId} is not a member of tenant ${tenantId}; credential write refused`,
    );
    this.name = "CredentialNotInTenantError";
  }
}

export class CredentialNotFoundError extends Error {
  constructor(public readonly credentialId: string) {
    super(`credential not found: ${credentialId}`);
    this.name = "CredentialNotFoundError";
  }
}

/**
 * Snapshot of a credential row used in audit before/after JSONB. Keep
 * field names snake_case so the audit row reads naturally in SQL/JSON
 * viewers and matches the FAA-style "what was the record" diff posture.
 */
interface CredentialSnapshot {
  id: string;
  user_id: string;
  regime_credential_type_id: string;
  certificate_number: string | null;
  ratings: string[];
  issued_on: string;
  expires_on: string | null;
  revoked_at: string | null;
  created_by_user_id: string | null;
}

function snapshot(row: UserCredential): CredentialSnapshot {
  return {
    id: row.id,
    user_id: row.userId,
    regime_credential_type_id: row.regimeCredentialTypeId,
    certificate_number: row.certificateNumber,
    ratings: row.ratings ?? [],
    issued_on: row.issuedOn,
    expires_on: row.expiresOn,
    revoked_at: row.revokedAt ? row.revokedAt.toISOString() : null,
    created_by_user_id: row.createdByUserId,
  };
}

/**
 * Service for credential CRUD + the A2.3 credential-gated sign-off
 * precondition.
 *
 * Two distinct surfaces share this class:
 *
 *   * The legacy `list/add/revoke` methods are tenant-agnostic and used
 *     internally by the sign-off precondition (`canSignOff`). They take
 *     a credential at face value because the sign-off path has already
 *     enforced tenant + role + membership upstream.
 *
 *   * The tenant-scoped CRUD methods (`createForTenant`,
 *     `updateForTenant`, `revokeForTenant`, `listForTenantMember`,
 *     `listActiveForTenantMember`) MUST be invoked inside a tenant
 *     transaction (`runAsTenant` / `runAsTenantOnProductionDb`). They
 *     enforce a membership-of-the-tenant precondition on the *target*
 *     user, write one append-only `user_credential_changes` row per
 *     mutation in the same transaction, and surface the no-N+1
 *     signoff-time read used by Epic G's credential card.
 */
export class CredentialService {
  constructor(private readonly db: AccountsDb) {}

  /**
   * Every non-revoked credential a user holds. Includes expired rows —
   * callers that need only currently-valid credentials should call
   * `canSignOff` / `listActiveForTenantMember` / filter on `expiresOn`.
   */
  async list(userId: string): Promise<UserCredential[]> {
    return this.db
      .select()
      .from(userCredentials)
      .where(
        and(
          eq(userCredentials.userId, userId),
          isNull(userCredentials.revokedAt),
        ),
      );
  }

  async add(input: AddCredentialInput): Promise<UserCredential> {
    const [row] = await this.db
      .insert(userCredentials)
      .values({
        userId: input.userId,
        regimeCredentialTypeId: input.regimeCredentialTypeId,
        certificateNumber: input.certificateNumber ?? null,
        ratings: input.ratings ? [...input.ratings] : [],
        issuedOn: input.issuedOn,
        expiresOn: input.expiresOn ?? null,
      })
      .returning();
    if (!row) throw new Error("failed to insert user credential");
    return row;
  }

  /**
   * Soft-revoke a credential. The row is retained for the audit trail
   * (a revoked A&P is a fact future regulators may need to see) and the
   * sign-off check filters it out via the `authorizes_signoff` join.
   */
  async revoke(credentialId: string, at: Date = new Date()): Promise<UserCredential> {
    const [row] = await this.db
      .update(userCredentials)
      .set({ revokedAt: at, updatedAt: at })
      .where(eq(userCredentials.id, credentialId))
      .returning();
    if (!row) throw new Error(`credential not found: ${credentialId}`);
    return row;
  }

  /**
   * True iff the user holds at least one credential under the supplied
   * regime whose credential-type row sets `authorizes_signoff = true`,
   * is not revoked, and is either undated or not yet expired.
   *
   * This is the only path that decides "this user MAY sign off today".
   * Callers gate the action on this *and* the role-level
   * `signoff.create` permission from the A2.1 matrix.
   */
  async canSignOff(
    userId: string,
    options: CanSignOffOptions,
  ): Promise<boolean> {
    const now = options.now ?? new Date();
    const today = now.toISOString().slice(0, 10);

    const rows = await this.db
      .select({ id: userCredentials.id })
      .from(userCredentials)
      .innerJoin(
        regimeCredentialTypes,
        eq(userCredentials.regimeCredentialTypeId, regimeCredentialTypes.id),
      )
      .where(
        and(
          eq(userCredentials.userId, userId),
          eq(regimeCredentialTypes.regimeId, options.regimeId),
          eq(regimeCredentialTypes.authorizesSignoff, true),
          isNull(userCredentials.revokedAt),
          sql`(${userCredentials.expiresOn} IS NULL OR ${userCredentials.expiresOn} >= ${today})`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  // ---------------------------------------------------------------------------
  // Tenant-scoped CRUD (PMB-155, Epic G).
  //
  // All five methods below assume `this.db` is a tenant-scoped transaction
  // handle (`runAsTenantOnProductionDb` / `runAsTenant`). RLS on the
  // membership table + the audit table enforces tenant isolation as a DB
  // property; the membership pre-check produces a clean 404/403 instead of
  // leaking row-existence via a downstream error.
  // ---------------------------------------------------------------------------

  /** Throws {@link CredentialNotInTenantError} if `targetUserId` isn't a member of `tenantId`. */
  private async assertMembership(
    tenantId: string,
    targetUserId: string,
  ): Promise<void> {
    const [m] = await this.db
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.tenantId, tenantId),
          eq(organizationMemberships.userId, targetUserId),
        ),
      )
      .limit(1);
    if (!m) throw new CredentialNotInTenantError(targetUserId, tenantId);
  }

  /** Read one credential by id, used as the before-snapshot fetch. */
  private async loadCredential(credentialId: string): Promise<UserCredential> {
    const [row] = await this.db
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.id, credentialId))
      .limit(1);
    if (!row) throw new CredentialNotFoundError(credentialId);
    return row;
  }

  /**
   * Admin-only path: create a credential for a member of `tenantId` and
   * write an audit row in the same transaction.
   */
  async createForTenant(input: CreateCredentialInput): Promise<UserCredential> {
    await this.assertMembership(input.tenantId, input.targetUserId);
    const [row] = await this.db
      .insert(userCredentials)
      .values({
        userId: input.targetUserId,
        regimeCredentialTypeId: input.regimeCredentialTypeId,
        certificateNumber: input.certificateNumber ?? null,
        ratings: input.ratings ? [...input.ratings] : [],
        issuedOn: input.issuedOn,
        expiresOn: input.expiresOn ?? null,
        createdByUserId: input.actorUserId,
      })
      .returning();
    if (!row) throw new Error("failed to insert user credential");
    await this.db.insert(userCredentialChanges).values({
      tenantId: input.tenantId,
      userCredentialId: row.id,
      targetUserId: input.targetUserId,
      actorUserId: input.actorUserId,
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: snapshot(row),
    });
    return row;
  }

  /**
   * Admin-only path: patch a credential and write an update audit row
   * with full before/after snapshots in the same transaction. Idempotent
   * with respect to ratings (same array → same audit row content).
   */
  async updateForTenant(input: UpdateCredentialInput): Promise<UserCredential> {
    const before = await this.loadCredential(input.credentialId);
    await this.assertMembership(input.tenantId, before.userId);

    const patch: Partial<{
      certificateNumber: string | null;
      ratings: string[];
      issuedOn: string;
      expiresOn: string | null;
      updatedAt: Date;
    }> = { updatedAt: new Date() };
    if (input.certificateNumber !== undefined)
      patch.certificateNumber = input.certificateNumber ?? null;
    if (input.ratings !== undefined)
      patch.ratings = input.ratings === null ? [] : [...input.ratings];
    if (input.issuedOn !== undefined) patch.issuedOn = input.issuedOn;
    if (input.expiresOn !== undefined)
      patch.expiresOn = input.expiresOn ?? null;

    const [after] = await this.db
      .update(userCredentials)
      .set(patch)
      .where(eq(userCredentials.id, input.credentialId))
      .returning();
    if (!after) throw new CredentialNotFoundError(input.credentialId);

    await this.db.insert(userCredentialChanges).values({
      tenantId: input.tenantId,
      userCredentialId: after.id,
      targetUserId: after.userId,
      actorUserId: input.actorUserId,
      action: "update",
      beforeSnapshot: snapshot(before),
      afterSnapshot: snapshot(after),
    });
    return after;
  }

  /**
   * Admin-only path: soft-revoke a credential and write an audit row.
   * Idempotent on already-revoked rows (returns the existing row without
   * a new audit write so re-clicks don't pollute the log).
   */
  async revokeForTenant(input: RevokeCredentialInput): Promise<UserCredential> {
    const before = await this.loadCredential(input.credentialId);
    await this.assertMembership(input.tenantId, before.userId);
    if (before.revokedAt) return before;
    const at = input.at ?? new Date();
    const [after] = await this.db
      .update(userCredentials)
      .set({ revokedAt: at, updatedAt: at })
      .where(eq(userCredentials.id, input.credentialId))
      .returning();
    if (!after) throw new CredentialNotFoundError(input.credentialId);
    await this.db.insert(userCredentialChanges).values({
      tenantId: input.tenantId,
      userCredentialId: after.id,
      targetUserId: after.userId,
      actorUserId: input.actorUserId,
      action: "revoke",
      beforeSnapshot: snapshot(before),
      afterSnapshot: snapshot(after),
    });
    return after;
  }

  /**
   * List all credentials (including revoked / expired) for a member of
   * the tenant, newest first. The membership pre-check enforces "no
   * cross-tenant view of a non-member's credentials" before the read.
   */
  async listForTenantMember(input: {
    tenantId: string;
    targetUserId: string;
  }): Promise<UserCredential[]> {
    await this.assertMembership(input.tenantId, input.targetUserId);
    return this.db
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.userId, input.targetUserId))
      .orderBy(desc(userCredentials.createdAt));
  }

  /**
   * Sign-off-time read: every current credential (non-revoked,
   * unexpired) for a member, joined to its credential-type row so the
   * caller can render "is this signer credentialed for this task right
   * now?" without an N+1.
   *
   * Filter by `regimeId` (typically the aircraft's regime); leave it
   * undefined for the "all current credentials" view.
   */
  async listActiveForTenantMember(input: {
    tenantId: string;
    targetUserId: string;
    regimeId?: string;
    now?: Date;
  }): Promise<ActiveCredentialView[]> {
    await this.assertMembership(input.tenantId, input.targetUserId);
    const now = input.now ?? new Date();
    const today = now.toISOString().slice(0, 10);
    const wheres = [
      eq(userCredentials.userId, input.targetUserId),
      isNull(userCredentials.revokedAt),
      sql`(${userCredentials.expiresOn} IS NULL OR ${userCredentials.expiresOn} >= ${today})`,
    ];
    if (input.regimeId !== undefined) {
      wheres.push(eq(regimeCredentialTypes.regimeId, input.regimeId));
    }
    const rows = await this.db
      .select({
        id: userCredentials.id,
        userId: userCredentials.userId,
        regimeCredentialTypeId: userCredentials.regimeCredentialTypeId,
        certificateNumber: userCredentials.certificateNumber,
        ratings: userCredentials.ratings,
        issuedOn: userCredentials.issuedOn,
        expiresOn: userCredentials.expiresOn,
        credentialTypeCode: regimeCredentialTypes.code,
        credentialTypeName: regimeCredentialTypes.name,
        authorizesSignoff: regimeCredentialTypes.authorizesSignoff,
      })
      .from(userCredentials)
      .innerJoin(
        regimeCredentialTypes,
        eq(userCredentials.regimeCredentialTypeId, regimeCredentialTypes.id),
      )
      .where(and(...wheres))
      .orderBy(desc(userCredentials.issuedOn));
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      regimeCredentialTypeId: r.regimeCredentialTypeId,
      credentialTypeCode: r.credentialTypeCode,
      credentialTypeName: r.credentialTypeName,
      authorizesSignoff: r.authorizesSignoff,
      certificateNumber: r.certificateNumber,
      ratings: r.ratings ?? [],
      issuedOn: r.issuedOn,
      expiresOn: r.expiresOn,
    }));
  }

  /**
   * Read the audit trail for a credential, newest first. Used by future
   * audit viewers; bounded callers should pass a `limit`.
   */
  async listAuditTrail(input: {
    credentialId: string;
    limit?: number;
  }): Promise<UserCredentialChange[]> {
    const q = this.db
      .select()
      .from(userCredentialChanges)
      .where(eq(userCredentialChanges.userCredentialId, input.credentialId))
      .orderBy(desc(userCredentialChanges.createdAt));
    return input.limit !== undefined ? q.limit(input.limit) : q;
  }
}

export type { RegimeCredentialType };
