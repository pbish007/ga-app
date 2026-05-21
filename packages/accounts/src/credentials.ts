import { and, eq, isNull, sql } from "drizzle-orm";

import { schema as dbSchema } from "@ga/db";
import type { UserCredential } from "@ga/db";

import type { AccountsDb } from "./db.js";

const { userCredentials, regimeCredentialTypes } = dbSchema;

export interface AddCredentialInput {
  userId: string;
  regimeCredentialTypeId: string;
  certificateNumber?: string | null;
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

/**
 * Service for the A2.3 credential-gated sign-off precondition.
 *
 * The `canSignOff` query is deliberately data-driven: it joins
 * `user_credentials` with `regime_credential_types` and filters on the
 * type row's `authorizes_signoff` column. It never switches on a
 * credential code string — that is the A2/A3 seam from spec §6
 * ("credential types are a data-driven table"). When Canada (or any
 * other regime) is added later, sign-off authority is configured in the
 * regime bundle, not in this code path.
 */
export class CredentialService {
  constructor(private readonly db: AccountsDb) {}

  /**
   * Every non-revoked credential a user holds, newest first. Includes
   * expired rows — callers that need only currently-valid credentials
   * should call `canSignOff` or filter on `expiresOn`.
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
}
