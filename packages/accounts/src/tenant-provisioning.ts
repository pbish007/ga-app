import { eq, sql } from "drizzle-orm";

import {
  ORG_TYPES,
  PROVISIONING_ACTOR_KINDS,
  schema as dbSchema,
  TENANT_APP_ROLE,
  USER_CONTEXT_GUC,
  type AppRoleCode,
  type OrgType,
  type ProvisioningActorKind,
  type TenantProvisioningAuditRow,
} from "@ga/db";
import { DEFAULT_REGIME_CODE, RegimeClient } from "@ga/regime";

import type { AccountsDb } from "./db.js";
import type { Mailer } from "./mailer.js";
import {
  InviteService,
  renderInviteEmail,
  type CreatedInvitation,
} from "./invitations.js";
import { passwordHasher, type PasswordHasher } from "./password.js";

const {
  organizationMemberships,
  organizations,
  tenantProvisioningAudit,
  users,
} = dbSchema;

/**
 * Discriminated provisioning-attempt actor. The `actorUserId` is required
 * for the platform-admin path (it's the admin doing the provisioning); it
 * is NULL for self-service (the new user does not exist yet when the
 * audit row is inserted).
 */
export type ProvisionedBy =
  | { kind: "self-service" }
  | { kind: "platform-admin"; actorUserId: string };

export interface ProvisionAdditionalSeat {
  email: string;
  role: AppRoleCode;
}

export interface ProvisionTenantInput {
  orgName: string;
  orgType: OrgType;
  /**
   * Override the platform default (FAA — K2 seam). Optional; if omitted,
   * the service resolves the default regime from the regime catalog.
   */
  regimeId?: string;
  primaryAdmin: {
    email: string;
    /**
     * Raw password — hashed inside the service. The hash never leaves
     * the database and is NEVER written into the audit `input_snapshot`.
     */
    password: string;
  };
  /**
   * Extra invitations to enqueue post-commit. Optional. Used by the
   * admin API (C3); self-service signup leaves this empty/undefined.
   */
  additionalSeats?: ProvisionAdditionalSeat[];
  provisionedBy: ProvisionedBy;
  /**
   * Stable per-real-world-tenant key. When set, a duplicate call with the
   * same key replays the prior `done` result without writes (or throws
   * `IdempotencyConflict` if the prior attempt is `in_progress`/`failed`).
   * Self-service signup leaves this undefined.
   */
  idempotencyKey?: string;
}

export interface ProvisionTenantResult {
  tenantId: string;
  primaryAdminUserId: string;
  invitationsSent: number;
  auditId: string;
}

export type ProvisioningErrorCode =
  | "email_already_exists"
  | "idempotency_conflict"
  | "invalid_regime"
  | "validation_error";

export class ProvisioningError extends Error {
  constructor(
    public readonly code: ProvisioningErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProvisioningError";
  }
}

export class EmailAlreadyExists extends ProvisioningError {
  constructor(email: string) {
    super("email_already_exists", `an account with email ${email} already exists`);
    this.name = "EmailAlreadyExists";
  }
}

export class IdempotencyConflict extends ProvisioningError {
  constructor(
    message: string,
    public readonly priorStatus: "in_progress" | "failed",
    public readonly priorAuditId: string,
  ) {
    super("idempotency_conflict", message);
    this.name = "IdempotencyConflict";
  }
}

export class InvalidRegime extends ProvisioningError {
  constructor(regimeId: string) {
    super("invalid_regime", `regime id ${regimeId} does not exist`);
    this.name = "InvalidRegime";
  }
}

export class ValidationError extends ProvisioningError {
  constructor(
    message: string,
    public readonly field: string,
  ) {
    super("validation_error", message);
    this.name = "ValidationError";
  }
}

/**
 * Optional invite mailer wiring. Self-service signup leaves this null —
 * the new admin has no extra seats to invite. The admin API (C3) wires a
 * real {@link OutboxMailer} + accept-url base so seat invites enqueue
 * post-commit.
 */
export interface InviteMailerDeps {
  mailer: Mailer;
  acceptUrlBase: string;
}

export interface ProvisionTenantDeps {
  db: AccountsDb;
  hasher?: PasswordHasher;
  /**
   * Wraps the org + admin-membership writes so the membership INSERT
   * runs under the `app_self_membership_insert` policy on the production
   * runtime role. Optional — in tests we run as superuser and skip the
   * role switch; in production the web app injects a wrapper that
   * `SET LOCAL ROLE tenant_app` + sets `app.current_user_id` inside the
   * shared transaction.
   *
   * The wrapper receives the BoundedTx, the brand-new user id, and a
   * callback that must INSERT the admin membership inside that same tx.
   */
  withMembershipTx?: <T>(
    tx: Parameters<Parameters<AccountsDb["transaction"]>[0]>[0],
    userId: string,
    fn: () => Promise<T>,
  ) => Promise<T>;
  /**
   * Optional invite mailer wiring for `additionalSeats`. Without it,
   * `additionalSeats` is rejected with a {@link ValidationError} — the
   * caller is expected to be the admin API (C3) which always supplies a
   * mailer.
   */
  inviteMailer?: InviteMailerDeps;
  /** Override the clock in tests. */
  now?: () => Date;
}

/**
 * The single tenant-creation entry point. Both self-service signup and
 * the admin API (C3) call into this service so there is exactly one
 * code path that creates a tenant — and exactly one audit log.
 *
 * Behaviour contract (from PMB-117):
 *   * Atomic: user + org + admin-membership land in one transaction.
 *     Any failure rolls back the whole tenant.
 *   * Idempotent on `idempotencyKey`: a second call with the same key
 *     replays the prior `done` result without writes; an in-flight or
 *     failed prior attempt throws `IdempotencyConflict`.
 *   * Post-commit invite enqueues NEVER roll back the tenant: a failed
 *     send adds a `warnings` entry to the audit row but leaves the
 *     tenant intact.
 *   * Typed errors at the boundary: callers map them to 4xx; the
 *     service throws them unwrapped.
 *   * Audit-logged: one row per attempt, regardless of outcome.
 */
export class TenantProvisioningService {
  private readonly hasher: PasswordHasher;
  private readonly clock: () => Date;
  private readonly regimes: RegimeClient;

  constructor(private readonly deps: ProvisionTenantDeps) {
    this.hasher = deps.hasher ?? passwordHasher;
    this.clock = deps.now ?? (() => new Date());
    this.regimes = new RegimeClient(deps.db);
  }

  async provisionTenant(
    input: ProvisionTenantInput,
  ): Promise<ProvisionTenantResult> {
    validateInput(input);

    const actorKind: ProvisioningActorKind = input.provisionedBy.kind;
    if (!PROVISIONING_ACTOR_KINDS.includes(actorKind)) {
      throw new ValidationError(
        `unknown provisionedBy.kind: ${actorKind}`,
        "provisionedBy.kind",
      );
    }
    const actorUserId =
      input.provisionedBy.kind === "platform-admin"
        ? input.provisionedBy.actorUserId
        : null;

    // ---- Idempotency lookup -----------------------------------------------
    // If a prior attempt with the same key already landed `done`, replay
    // its result without any new writes (the contract on PMB-117). A
    // prior in_progress/failed row is a hard conflict — the caller must
    // resolve it before retrying with the same key.
    if (input.idempotencyKey) {
      const prior = await this.findAuditByIdempotencyKey(input.idempotencyKey);
      if (prior) {
        if (prior.resultStatus === "done") {
          return decodeDoneResult(prior);
        }
        throw new IdempotencyConflict(
          `prior attempt with key ${input.idempotencyKey} is ${prior.resultStatus}`,
          prior.resultStatus as "in_progress" | "failed",
          prior.id,
        );
      }
    }

    // ---- Resolve regime ---------------------------------------------------
    const regimeId = await this.resolveRegimeId(input.regimeId);

    // ---- Pre-flight: refuse a duplicate identity --------------------------
    // The signup contract is "create a NEW user." Existing identities join
    // additional orgs via invitations, not via re-provisioning. We check
    // before opening the in_progress audit row so a duplicate-email retry
    // doesn't leak an extra audit row (the audit log is for *attempts to
    // create a tenant*, not for input-validation noise).
    const lowerEmail = input.primaryAdmin.email.trim().toLowerCase();
    const existing = await this.deps.db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${lowerEmail}`)
      .limit(1);
    if (existing[0]) {
      throw new EmailAlreadyExists(lowerEmail);
    }

    // ---- Open the audit row (in_progress) ---------------------------------
    const auditId = await this.openAuditRow({
      idempotencyKey: input.idempotencyKey ?? null,
      actorUserId,
      actorKind,
      inputSnapshot: snapshotInput(input, lowerEmail),
    });

    // ---- The atomic provisioning tx ---------------------------------------
    let tenantId: string;
    let primaryAdminUserId: string;
    try {
      const passwordHash = await this.hasher.hash(input.primaryAdmin.password);
      const now = this.clock();

      const result = await this.deps.db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({
            email: lowerEmail,
            passwordHash,
            emailVerifiedAt: now,
            passwordChangedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!user) throw new Error("failed to insert user");

        const [org] = await tx
          .insert(organizations)
          .values({
            name: input.orgName.trim(),
            orgType: input.orgType,
            defaultRegimeId: regimeId,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!org) throw new Error("failed to insert organization");

        // The membership INSERT runs under the `app_self_membership_insert`
        // policy on the production runtime role. The `withMembershipTx`
        // wrapper SET LOCAL ROLE tenant_app + sets `app.current_user_id`
        // before invoking the callback. Tests run as superuser and pass
        // through without the role switch.
        const insertMembership = async () => {
          await tx.insert(organizationMemberships).values({
            tenantId: org.id,
            userId: user.id,
            role: "admin",
            createdAt: now,
            updatedAt: now,
          });
        };
        if (this.deps.withMembershipTx) {
          await this.deps.withMembershipTx(tx, user.id, insertMembership);
        } else {
          await insertMembership();
        }

        return { tenantId: org.id, primaryAdminUserId: user.id };
      });
      tenantId = result.tenantId;
      primaryAdminUserId = result.primaryAdminUserId;
    } catch (err) {
      await this.failAuditRow(auditId, err);
      throw err;
    }

    // ---- Post-commit invite enqueues (NEVER roll back the tenant) ---------
    const warnings: Array<{ recipient: string; error: string }> = [];
    let invitationsSent = 0;
    if (input.additionalSeats && input.additionalSeats.length > 0) {
      if (!this.deps.inviteMailer) {
        // Adding the seats would silently drop the invite emails. Treat
        // it as a programmer error rather than a runtime one — the C3
        // admin route is always wired with a mailer.
        await this.failAuditRow(
          auditId,
          new ValidationError(
            "additionalSeats requires inviteMailer wiring",
            "additionalSeats",
          ),
        );
        throw new ValidationError(
          "additionalSeats requires inviteMailer wiring",
          "additionalSeats",
        );
      }
      const inviteService = new InviteService(this.deps.db, this.hasher);
      for (const seat of input.additionalSeats) {
        try {
          const created = await inviteService.create({
            tenantId,
            email: seat.email,
            role: seat.role,
            invitedByUserId: primaryAdminUserId,
          });
          await this.enqueueInvite({
            invitation: created,
            organizationName: input.orgName.trim(),
            mailer: this.deps.inviteMailer.mailer,
            acceptUrlBase: this.deps.inviteMailer.acceptUrlBase,
          });
          invitationsSent += 1;
        } catch (sendErr) {
          // Per PMB-117: a failed enqueue does NOT roll back the tenant.
          // Capture the warning into the audit row and keep going.
          warnings.push({
            recipient: seat.email,
            error: errorMessage(sendErr),
          });
        }
      }
    }

    // ---- Close the audit row (done) ---------------------------------------
    const resultSnapshot = {
      tenantId,
      primaryAdminUserId,
      invitationsSent,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    await this.deps.db
      .update(tenantProvisioningAudit)
      .set({
        createdTenantId: tenantId,
        actorUserId: actorUserId ?? primaryAdminUserId,
        resultStatus: "done",
        resultSnapshot,
        completedAt: this.clock(),
      })
      .where(eq(tenantProvisioningAudit.id, auditId));

    return { tenantId, primaryAdminUserId, invitationsSent, auditId };
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private async resolveRegimeId(regimeId?: string): Promise<string> {
    if (!regimeId) {
      const regime = await this.regimes.getByCode(DEFAULT_REGIME_CODE);
      return regime.id;
    }
    // Validate the supplied id is real — Postgres FK will catch this
    // eventually, but we'd rather throw a typed error than a bare DB
    // exception. Look it up before we open the audit row.
    const rows = await this.deps.db
      .select({ id: dbSchema.regimes.id })
      .from(dbSchema.regimes)
      .where(eq(dbSchema.regimes.id, regimeId))
      .limit(1);
    if (!rows[0]) throw new InvalidRegime(regimeId);
    return rows[0].id;
  }

  private async findAuditByIdempotencyKey(
    key: string,
  ): Promise<TenantProvisioningAuditRow | null> {
    const rows = await this.deps.db
      .select()
      .from(tenantProvisioningAudit)
      .where(eq(tenantProvisioningAudit.idempotencyKey, key))
      .limit(1);
    return rows[0] ?? null;
  }

  private async openAuditRow(args: {
    idempotencyKey: string | null;
    actorUserId: string | null;
    actorKind: ProvisioningActorKind;
    inputSnapshot: Record<string, unknown>;
  }): Promise<string> {
    try {
      const [row] = await this.deps.db
        .insert(tenantProvisioningAudit)
        .values({
          idempotencyKey: args.idempotencyKey,
          actorUserId: args.actorUserId,
          actorKind: args.actorKind,
          inputSnapshot: args.inputSnapshot,
          resultStatus: "in_progress",
          createdAt: this.clock(),
        })
        .returning();
      if (!row) throw new Error("failed to insert audit row");
      return row.id;
    } catch (err) {
      // Concurrent caller won the idempotency-key race. Re-read and
      // surface the appropriate result/conflict.
      if (args.idempotencyKey && isUniqueViolation(err)) {
        const prior = await this.findAuditByIdempotencyKey(args.idempotencyKey);
        if (prior && prior.resultStatus === "done") {
          // Caller will discard openAuditRow's result and return this.
          throw new IdempotencyReplay(prior);
        }
        if (prior) {
          throw new IdempotencyConflict(
            `prior attempt with key ${args.idempotencyKey} is ${prior.resultStatus}`,
            prior.resultStatus as "in_progress" | "failed",
            prior.id,
          );
        }
      }
      throw err;
    }
  }

  private async failAuditRow(auditId: string, err: unknown): Promise<void> {
    const error =
      err instanceof ProvisioningError
        ? { code: err.code, message: err.message }
        : { code: "unknown", message: errorMessage(err) };
    await this.deps.db
      .update(tenantProvisioningAudit)
      .set({
        resultStatus: "failed",
        error,
        completedAt: this.clock(),
      })
      .where(eq(tenantProvisioningAudit.id, auditId));
  }

  private async enqueueInvite(args: {
    invitation: CreatedInvitation;
    organizationName: string;
    mailer: Mailer;
    acceptUrlBase: string;
  }): Promise<void> {
    const rendered = renderInviteEmail({
      invitation: args.invitation.invitation,
      rawToken: args.invitation.rawToken,
      organizationName: args.organizationName,
      acceptUrlBase: args.acceptUrlBase,
    });
    await args.mailer.send({
      tenantId: args.invitation.invitation.tenantId,
      recipientEmail: args.invitation.invitation.email,
      subject: rendered.subject,
      bodyText: rendered.bodyText,
      bodyHtml: rendered.bodyHtml,
    });
  }
}

/**
 * Internal — thrown by `openAuditRow` to flag "concurrent caller already
 * landed the same key with status=done; replay their result without
 * writes." `provisionTenant` catches it and returns the cached result.
 */
class IdempotencyReplay {
  constructor(public readonly priorRow: TenantProvisioningAuditRow) {}
}

/**
 * Convenience top-level wrapper so callers can write `provisionTenant(...)`
 * without instantiating the service. Mirrors how `sendInvitation` shadows
 * `InviteService` for the same package.
 */
export async function provisionTenant(
  deps: ProvisionTenantDeps,
  input: ProvisionTenantInput,
): Promise<ProvisionTenantResult> {
  const service = new TenantProvisioningService(deps);
  try {
    return await service.provisionTenant(input);
  } catch (err) {
    if (err instanceof IdempotencyReplay) {
      return decodeDoneResult(err.priorRow);
    }
    throw err;
  }
}

function validateInput(input: ProvisionTenantInput): void {
  if (!input.orgName || !input.orgName.trim()) {
    throw new ValidationError("orgName is required", "orgName");
  }
  if (!(ORG_TYPES as readonly string[]).includes(input.orgType)) {
    throw new ValidationError(
      `orgType must be one of: ${ORG_TYPES.join(", ")}`,
      "orgType",
    );
  }
  const email = input.primaryAdmin?.email;
  if (
    typeof email !== "string" ||
    !email.includes("@") ||
    email.length > 320
  ) {
    throw new ValidationError(
      "primaryAdmin.email must be a valid email",
      "primaryAdmin.email",
    );
  }
  const password = input.primaryAdmin?.password;
  if (typeof password !== "string" || password.length < 8) {
    throw new ValidationError(
      "primaryAdmin.password must be at least 8 characters",
      "primaryAdmin.password",
    );
  }
  if (input.provisionedBy.kind === "platform-admin") {
    if (
      typeof input.provisionedBy.actorUserId !== "string" ||
      !input.provisionedBy.actorUserId
    ) {
      throw new ValidationError(
        "platform-admin provisionedBy requires actorUserId",
        "provisionedBy.actorUserId",
      );
    }
  }
}

function snapshotInput(
  input: ProvisionTenantInput,
  normalizedEmail: string,
): Record<string, unknown> {
  // Strip the password — passwords NEVER land in the audit log.
  return {
    orgName: input.orgName.trim(),
    orgType: input.orgType,
    regimeId: input.regimeId ?? null,
    primaryAdmin: { email: normalizedEmail },
    additionalSeats: (input.additionalSeats ?? []).map((s) => ({
      email: s.email.trim().toLowerCase(),
      role: s.role,
    })),
    provisionedBy: input.provisionedBy,
    idempotencyKey: input.idempotencyKey ?? null,
  };
}

function decodeDoneResult(
  row: TenantProvisioningAuditRow,
): ProvisionTenantResult {
  const snap = (row.resultSnapshot ?? {}) as Record<string, unknown>;
  const tenantId =
    typeof snap.tenantId === "string"
      ? snap.tenantId
      : row.createdTenantId ?? "";
  const primaryAdminUserId =
    typeof snap.primaryAdminUserId === "string"
      ? snap.primaryAdminUserId
      : "";
  const invitationsSent =
    typeof snap.invitationsSent === "number" ? snap.invitationsSent : 0;
  return {
    tenantId,
    primaryAdminUserId,
    invitationsSent,
    auditId: row.id,
  };
}

function isUniqueViolation(err: unknown): boolean {
  // Drizzle wraps both postgres-js and pglite errors; both expose the
  // SQLSTATE on `.code` when it's a real Postgres error. 23505 is unique
  // violation. We also fall through to a substring check on the message
  // so a pglite engine difference doesn't silently change behaviour.
  if (typeof err === "object" && err !== null) {
    const e = err as { code?: unknown; message?: unknown };
    if (e.code === "23505") return true;
    if (typeof e.message === "string" && /unique|duplicate key/i.test(e.message)) {
      return true;
    }
  }
  return false;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "unknown error";
}

// Re-export GUC names + the runtime role so callers (apps/web) can share
// the constants without reaching into @ga/db directly. Mirrors how the
// existing `runAsIdentityOnProductionDb` consumes them.
export { TENANT_APP_ROLE, USER_CONTEXT_GUC };
