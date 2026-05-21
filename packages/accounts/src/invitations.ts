import { createHash, randomBytes } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { schema as dbSchema } from "@ga/db";
import type {
  AppRoleCode,
  Invitation,
  OrganizationMembership,
  User,
} from "@ga/db";

import type { AccountsDb } from "./db.js";
import type { Mailer } from "./mailer.js";
import { passwordHasher, type PasswordHasher } from "./password.js";

const { invitations, organizationMemberships, users } = dbSchema;

const TOKEN_BYTES = 32;
const DEFAULT_TTL_HOURS = 72;

export class InviteError extends Error {
  constructor(
    public readonly code:
      | "invalid_token"
      | "expired"
      | "already_accepted"
      | "duplicate_membership",
    message: string,
  ) {
    super(message);
    this.name = "InviteError";
  }
}

export interface CreateInvitationInput {
  tenantId: string;
  email: string;
  role: AppRoleCode;
  invitedByUserId: string;
  ttlHours?: number;
}

export interface CreatedInvitation {
  invitation: Invitation;
  /**
   * Raw token to embed in the invite email link. Available exactly
   * once — the database stores only `sha256(rawToken)`.
   */
  rawToken: string;
}

export interface AcceptInvitationInput {
  rawToken: string;
  password: string;
}

export interface AcceptedInvitation {
  invitation: Invitation;
  user: User;
  membership: OrganizationMembership;
}

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

function generateRawToken(): string {
  // URL-safe base64 (RFC 4648 §5) so the token fits in a link parameter.
  return randomBytes(TOKEN_BYTES)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

export class InviteService {
  constructor(
    private readonly db: AccountsDb,
    private readonly hasher: PasswordHasher = passwordHasher,
  ) {}

  async create(input: CreateInvitationInput): Promise<CreatedInvitation> {
    const rawToken = generateRawToken();
    const tokenHash = hashToken(rawToken);
    const ttlHours = input.ttlHours ?? DEFAULT_TTL_HOURS;
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    const [invitation] = await this.db
      .insert(invitations)
      .values({
        tenantId: input.tenantId,
        email: input.email.trim(),
        role: input.role,
        invitedByUserId: input.invitedByUserId,
        tokenHash,
        expiresAt,
      })
      .returning();
    if (!invitation) {
      throw new Error("failed to insert invitation");
    }
    return { invitation, rawToken };
  }

  /**
   * Look up an invitation by its raw token. Used by the invite-accept
   * UI to render a "Hi <email>, you've been invited to <org>" landing
   * page without exposing the token in app state. Returns null if the
   * token is unknown — does NOT throw, since accept() handles the
   * security-relevant cases.
   */
  async findByRawToken(rawToken: string): Promise<Invitation | null> {
    const rows = await this.db
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, hashToken(rawToken)));
    return rows[0] ?? null;
  }

  async accept(input: AcceptInvitationInput): Promise<AcceptedInvitation> {
    const invitation = await this.findByRawToken(input.rawToken);
    if (!invitation) {
      throw new InviteError("invalid_token", "invitation not found");
    }
    if (invitation.acceptedAt) {
      throw new InviteError(
        "already_accepted",
        "invitation has already been accepted",
      );
    }
    if (invitation.expiresAt.getTime() <= Date.now()) {
      throw new InviteError("expired", "invitation has expired");
    }

    const passwordHash = await this.hasher.hash(input.password);
    const now = new Date();

    // Find-or-create the user. Email matches case-insensitively to mirror
    // the `users_email_lower_unique` index.
    const existing = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = lower(${invitation.email})`);
    let user = existing[0];
    if (user) {
      // Existing identity (e.g. someone invited to a second org).
      // We do NOT clobber their password — spec §4 Epic A: passwords
      // are user-set only.
    } else {
      const [created] = await this.db
        .insert(users)
        .values({
          email: invitation.email,
          passwordHash,
          emailVerifiedAt: now,
          passwordChangedAt: now,
        })
        .returning();
      if (!created) {
        throw new Error("failed to insert user");
      }
      user = created;
    }

    // Refuse a duplicate membership rather than silently no-op'ing.
    const existingMembership = await this.db
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.tenantId, invitation.tenantId),
          eq(organizationMemberships.userId, user.id),
        ),
      );
    if (existingMembership[0]) {
      throw new InviteError(
        "duplicate_membership",
        "user is already a member of this organization",
      );
    }

    const [membership] = await this.db
      .insert(organizationMemberships)
      .values({
        tenantId: invitation.tenantId,
        userId: user.id,
        role: invitation.role,
      })
      .returning();
    if (!membership) {
      throw new Error("failed to insert membership");
    }

    const [updated] = await this.db
      .update(invitations)
      .set({ acceptedAt: now, updatedAt: now })
      .where(eq(invitations.id, invitation.id))
      .returning();
    if (!updated) {
      throw new Error("failed to mark invitation accepted");
    }

    return { invitation: updated, user, membership };
  }
}

export interface InviteEmailRendererInput {
  invitation: Invitation;
  rawToken: string;
  organizationName: string;
  acceptUrlBase: string;
}

export interface RenderedInviteEmail {
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

/**
 * Renders the invite email body. Kept regime-agnostic and plain-language
 * — no regulatory text. Per spec §3.6, the platform never speaks for
 * the regulator.
 */
export function renderInviteEmail(
  input: InviteEmailRendererInput,
): RenderedInviteEmail {
  const url = `${input.acceptUrlBase.replace(/\/$/, "")}/${encodeURIComponent(input.rawToken)}`;
  const subject = `You're invited to ${input.organizationName}`;
  const bodyText =
    `You've been invited to join ${input.organizationName}` +
    ` on the General Aviation Maintenance platform as ${input.invitation.role}.\n\n` +
    `Set your password and join: ${url}\n\n` +
    `This invitation expires on ${input.invitation.expiresAt.toISOString()}.`;
  const bodyHtml =
    `<p>You've been invited to join <strong>${escapeHtml(input.organizationName)}</strong> ` +
    `on the General Aviation Maintenance platform as <code>${escapeHtml(
      input.invitation.role,
    )}</code>.</p>` +
    `<p><a href="${escapeAttr(url)}">Set your password and join</a></p>` +
    `<p>This invitation expires on ${escapeHtml(
      input.invitation.expiresAt.toISOString(),
    )}.</p>`;
  return { subject, bodyText, bodyHtml };
}

export interface SendInvitationDeps {
  inviteService: InviteService;
  mailer: Mailer;
  acceptUrlBase: string;
  /**
   * Resolve the display name for the tenant; passed in so the accounts
   * package stays decoupled from how the caller loads orgs.
   */
  resolveOrganizationName: (tenantId: string) => Promise<string>;
}

/**
 * Convenience: create the invitation, render the email, enqueue via the
 * Mailer. The mailer is interface-bound — tests use a stub, production
 * uses OutboxMailer.
 */
export async function sendInvitation(
  deps: SendInvitationDeps,
  input: CreateInvitationInput,
): Promise<CreatedInvitation> {
  const created = await deps.inviteService.create(input);
  const organizationName = await deps.resolveOrganizationName(input.tenantId);
  const rendered = renderInviteEmail({
    invitation: created.invitation,
    rawToken: created.rawToken,
    organizationName,
    acceptUrlBase: deps.acceptUrlBase,
  });
  await deps.mailer.send({
    tenantId: input.tenantId,
    recipientEmail: created.invitation.email,
    subject: rendered.subject,
    bodyText: rendered.bodyText,
    bodyHtml: rendered.bodyHtml,
  });
  return created;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
