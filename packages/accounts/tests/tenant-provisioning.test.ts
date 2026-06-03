import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { schema as dbSchema, setupTestSuite, type TestDb } from "@ga/db";
import { DEFAULT_REGIME_CODE, RegimeClient } from "@ga/regime";

import {
  EmailAlreadyExists,
  IdempotencyConflict,
  InvalidRegime,
  OutboxMailer,
  TenantProvisioningService,
  ValidationError,
  passwordHasher,
  provisionTenant,
  type Mailer,
  type OutgoingEmail,
  type ProvisionTenantDeps,
} from "../src/index.js";

const {
  emailOutbox,
  invitations,
  organizations,
  organizationMemberships,
  tenantProvisioningAudit,
  users,
} = dbSchema;

let db: TestDb;
let reset: () => Promise<void>;

describe("PMB-117 TenantProvisioningService", () => {
  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });

  afterEach(async () => {
    await reset();
  });

  // ---- happy path -----------------------------------------------------------

  it("provisions a tenant atomically (user + org + admin-membership) and writes an audit row", async () => {
    const result = await provisionTenant(
      { db },
      {
        orgName: "Skyhawk Flying Club",
        orgType: "club",
        primaryAdmin: {
          email: "Founder@Example.test",
          password: "hunter2-the-strong-one",
        },
        provisionedBy: { kind: "self-service" },
      },
    );

    expect(result.tenantId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.primaryAdminUserId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.invitationsSent).toBe(0);
    expect(result.auditId).toMatch(/^[0-9a-f-]{36}$/i);

    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, result.tenantId));
    expect(org?.name).toBe("Skyhawk Flying Club");
    expect(org?.orgType).toBe("club");
    // K2 seam: defaults to FAA when no regimeId override is supplied.
    const regimes = new RegimeClient(db);
    const faa = await regimes.getByCode(DEFAULT_REGIME_CODE);
    expect(org?.defaultRegimeId).toBe(faa.id);

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, result.primaryAdminUserId));
    // Email is normalized to lowercase + trimmed before insert.
    expect(user?.email).toBe("founder@example.test");
    expect(user?.passwordHash).toMatch(/^scrypt\$/);
    expect(
      await passwordHasher.verify(
        "hunter2-the-strong-one",
        user!.passwordHash!,
      ),
    ).toBe(true);

    const memberships = await db
      .select()
      .from(organizationMemberships)
      .where(eq(organizationMemberships.tenantId, result.tenantId));
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.userId).toBe(result.primaryAdminUserId);
    expect(memberships[0]?.role).toBe("admin");

    const [audit] = await db
      .select()
      .from(tenantProvisioningAudit)
      .where(eq(tenantProvisioningAudit.id, result.auditId));
    expect(audit?.resultStatus).toBe("done");
    expect(audit?.createdTenantId).toBe(result.tenantId);
    expect(audit?.completedAt).toBeInstanceOf(Date);
    expect(audit?.actorKind).toBe("self-service");
    expect(audit?.actorUserId).toBe(result.primaryAdminUserId);
    // Audit input snapshot strips the password.
    const snap = audit!.inputSnapshot as Record<string, unknown>;
    expect(snap.primaryAdmin).toEqual({ email: "founder@example.test" });
    expect(JSON.stringify(snap)).not.toContain("hunter2");
    const resultSnap = audit!.resultSnapshot as Record<string, unknown>;
    expect(resultSnap.tenantId).toBe(result.tenantId);
    expect(resultSnap.primaryAdminUserId).toBe(result.primaryAdminUserId);
    expect(resultSnap.invitationsSent).toBe(0);
  });

  it("honors an explicit regimeId override", async () => {
    const regimes = new RegimeClient(db);
    const cars = await regimes.createBundle({
      code: "CARS-T-117",
      name: "Canadian Aviation Regulations (test)",
      jurisdiction: "Canada",
    });
    const result = await provisionTenant(
      { db },
      {
        orgName: "Toronto Maintenance Co.",
        orgType: "shop",
        regimeId: cars.regime.id,
        primaryAdmin: {
          email: "ops@torontomaintenance.test",
          password: "long-enough-password",
        },
        provisionedBy: { kind: "self-service" },
      },
    );
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, result.tenantId));
    expect(org?.defaultRegimeId).toBe(cars.regime.id);
  });

  // ---- idempotency ----------------------------------------------------------

  /**
   * Acceptance drill from the issue body: same `idempotencyKey` called
   * twice produces ONE tenant and ONE audit row — the second call replays
   * the first call's result. No second audit row, no second org.
   */
  it("idempotency: a second call with the same key replays the prior result with no new writes", async () => {
    const deps = { db };
    const input = {
      orgName: "Idempotent Aero",
      orgType: "club" as const,
      primaryAdmin: {
        email: "admin@idempotent.test",
        password: "idempotent-password-1",
      },
      provisionedBy: { kind: "self-service" as const },
      idempotencyKey: "tenant:idempotent-aero",
    };

    const first = await provisionTenant(deps, input);
    const second = await provisionTenant(deps, input);

    expect(second).toEqual(first);

    // ONE org, ONE user, ONE audit row.
    const orgCount = await db.select().from(organizations);
    expect(orgCount).toHaveLength(1);
    const userCount = await db.select().from(users);
    expect(userCount).toHaveLength(1);
    const auditCount = await db.select().from(tenantProvisioningAudit);
    expect(auditCount).toHaveLength(1);
    expect(auditCount[0]?.idempotencyKey).toBe("tenant:idempotent-aero");
  });

  it("idempotency: a key in `in_progress` from a prior crashed attempt throws IdempotencyConflict", async () => {
    // Simulate a prior attempt that opened the audit row but never closed
    // it (e.g. the process crashed mid-tx).
    await db.insert(tenantProvisioningAudit).values({
      idempotencyKey: "tenant:abandoned",
      actorKind: "platform-admin",
      inputSnapshot: { orgName: "abandoned" },
      resultStatus: "in_progress",
    });

    const platformAdmin = await seedUser(db, "admin@platform.test");
    await expect(
      provisionTenant(
        { db },
        {
          orgName: "Retry Co",
          orgType: "shop",
          primaryAdmin: {
            email: "retry@example.test",
            password: "another-password",
          },
          provisionedBy: { kind: "platform-admin", actorUserId: platformAdmin },
          idempotencyKey: "tenant:abandoned",
        },
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflict);
  });

  // ---- transactional rollback ----------------------------------------------

  /**
   * If the membership INSERT fails after the user + org INSERTs, the
   * whole transaction must roll back: no user row, no org row, audit row
   * marked `failed`.
   */
  it("transactional rollback: a failing membership write rolls back the user + org", async () => {
    // We trip the membership INSERT by injecting a withMembershipTx
    // wrapper that throws AFTER the org INSERT (the user/org writes have
    // happened inside the same drizzle tx, so they should both unwind).
    const deps: ProvisionTenantDeps = {
      db,
      withMembershipTx: async () => {
        throw new Error("membership write blew up");
      },
    };

    await expect(
      provisionTenant(deps, {
        orgName: "Doomed Ops",
        orgType: "owner",
        primaryAdmin: {
          email: "doomed@example.test",
          password: "long-enough-password",
        },
        provisionedBy: { kind: "self-service" },
      }),
    ).rejects.toThrow(/membership write blew up/);

    // No user, no org, no membership.
    const usersAfter = await db.select().from(users);
    expect(usersAfter).toHaveLength(0);
    const orgsAfter = await db.select().from(organizations);
    expect(orgsAfter).toHaveLength(0);
    const memberships = await db.select().from(organizationMemberships);
    expect(memberships).toHaveLength(0);

    // The audit row stays — that's the whole point of the audit log.
    const audits = await db.select().from(tenantProvisioningAudit);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.resultStatus).toBe("failed");
    expect(audits[0]?.createdTenantId).toBeNull();
    expect(audits[0]?.completedAt).toBeInstanceOf(Date);
    const err = audits[0]?.error as Record<string, unknown>;
    expect(err?.message).toMatch(/membership write blew up/);
  });

  // ---- typed errors ---------------------------------------------------------

  it("typed error: EmailAlreadyExists when the primary admin email is taken", async () => {
    await seedUser(db, "Taken@example.test");

    await expect(
      provisionTenant(
        { db },
        {
          orgName: "Second Try",
          orgType: "club",
          primaryAdmin: {
            email: "TAKEN@example.test",
            password: "long-enough-password",
          },
          provisionedBy: { kind: "self-service" },
        },
      ),
    ).rejects.toBeInstanceOf(EmailAlreadyExists);

    // No audit row for input-validation-style failures — the audit log is
    // for attempts that opened a tenant write, not for "you typed a known
    // email" noise.
    const audits = await db.select().from(tenantProvisioningAudit);
    expect(audits).toHaveLength(0);
  });

  it("typed error: ValidationError on empty orgName / bogus orgType / weak password", async () => {
    await expect(
      provisionTenant(
        { db },
        {
          orgName: "   ",
          orgType: "club",
          primaryAdmin: { email: "x@example.test", password: "longenough" },
          provisionedBy: { kind: "self-service" },
        },
      ),
    ).rejects.toMatchObject({ name: "ValidationError", field: "orgName" });

    await expect(
      provisionTenant(
        { db },
        {
          orgName: "Real Org",
          orgType: "airline" as unknown as "club",
          primaryAdmin: { email: "x@example.test", password: "longenough" },
          provisionedBy: { kind: "self-service" },
        },
      ),
    ).rejects.toMatchObject({ name: "ValidationError", field: "orgType" });

    await expect(
      provisionTenant(
        { db },
        {
          orgName: "Real Org",
          orgType: "club",
          primaryAdmin: { email: "x@example.test", password: "short" },
          provisionedBy: { kind: "self-service" },
        },
      ),
    ).rejects.toMatchObject({
      name: "ValidationError",
      field: "primaryAdmin.password",
    });
  });

  it("typed error: InvalidRegime when an unknown regimeId is supplied", async () => {
    await expect(
      provisionTenant(
        { db },
        {
          orgName: "Phantom Regime Co",
          orgType: "owner",
          regimeId: "00000000-0000-0000-0000-000000000000",
          primaryAdmin: {
            email: "phantom@example.test",
            password: "long-enough-password",
          },
          provisionedBy: { kind: "self-service" },
        },
      ),
    ).rejects.toBeInstanceOf(InvalidRegime);
  });

  // ---- platform-admin path + invites ---------------------------------------

  it("enqueues invitations for additional seats via the supplied mailer (does not roll back the tenant on send failure)", async () => {
    const admin = await seedUser(db, "platform-admin@example.test");

    const sent: OutgoingEmail[] = [];
    const stubMailer: Mailer = { send: async (m) => void sent.push(m) };

    const result = await provisionTenant(
      { db, inviteMailer: { mailer: stubMailer, acceptUrlBase: "https://app.example.test/invitations" } },
      {
        orgName: "Seeded Seats",
        orgType: "school",
        primaryAdmin: {
          email: "owner@seeded.test",
          password: "long-enough-password",
        },
        additionalSeats: [
          { email: "mech@seeded.test", role: "mechanic" },
          { email: "pilot@seeded.test", role: "pilot" },
        ],
        provisionedBy: { kind: "platform-admin", actorUserId: admin },
      },
    );

    expect(result.invitationsSent).toBe(2);
    expect(sent).toHaveLength(2);

    const invites = await db
      .select()
      .from(invitations)
      .where(eq(invitations.tenantId, result.tenantId));
    expect(invites).toHaveLength(2);
    // Inviter is the brand-new primary admin (not the platform admin).
    for (const inv of invites) {
      expect(inv.invitedByUserId).toBe(result.primaryAdminUserId);
    }

    const [audit] = await db
      .select()
      .from(tenantProvisioningAudit)
      .where(eq(tenantProvisioningAudit.id, result.auditId));
    const snap = audit!.resultSnapshot as Record<string, unknown>;
    expect(snap.invitationsSent).toBe(2);
    expect(snap.warnings).toBeUndefined();
  });

  it("captures invite-mailer failures as warnings in the audit row without rolling back the tenant", async () => {
    const admin = await seedUser(db, "platform-admin2@example.test");

    const failingMailer: Mailer = {
      send: async () => {
        throw new Error("smtp down");
      },
    };

    const result = await provisionTenant(
      { db, inviteMailer: { mailer: failingMailer, acceptUrlBase: "https://app.example.test/i" } },
      {
        orgName: "Warns On Mail",
        orgType: "shop",
        primaryAdmin: {
          email: "owner@warns.test",
          password: "long-enough-password",
        },
        additionalSeats: [{ email: "mech@warns.test", role: "mechanic" }],
        provisionedBy: { kind: "platform-admin", actorUserId: admin },
      },
    );

    expect(result.invitationsSent).toBe(0);

    const [audit] = await db
      .select()
      .from(tenantProvisioningAudit)
      .where(eq(tenantProvisioningAudit.id, result.auditId));
    expect(audit?.resultStatus).toBe("done");
    const snap = audit!.resultSnapshot as Record<string, unknown>;
    expect(snap.warnings).toEqual([
      { recipient: "mech@warns.test", error: "smtp down" },
    ]);

    // The tenant + admin landed despite the mailer failure.
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, result.tenantId));
    expect(org).toBeDefined();
  });

  it("emits invitations through the OutboxMailer to email_outbox when no stub is provided", async () => {
    const admin = await seedUser(db, "platform-admin3@example.test");
    const mailer = new OutboxMailer(db);

    const result = await provisionTenant(
      { db, inviteMailer: { mailer, acceptUrlBase: "https://app.example.test/i" } },
      {
        orgName: "Outbox Seats",
        orgType: "club",
        primaryAdmin: {
          email: "owner@outbox.test",
          password: "long-enough-password",
        },
        additionalSeats: [{ email: "mechx@outbox.test", role: "mechanic" }],
        provisionedBy: { kind: "platform-admin", actorUserId: admin },
      },
    );

    expect(result.invitationsSent).toBe(1);
    const queued = await db.select().from(emailOutbox);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.tenantId).toBe(result.tenantId);
    expect(queued[0]?.recipientEmail).toBe("mechx@outbox.test");
    expect(queued[0]?.status).toBe("pending");
  });

  // ---- service plumbing -----------------------------------------------------

  it("the TenantProvisioningService class wraps provisionTenant equivalently", async () => {
    const service = new TenantProvisioningService({ db });
    const result = await service.provisionTenant({
      orgName: "Class Co",
      orgType: "owner",
      primaryAdmin: {
        email: "owner@class.test",
        password: "long-enough-password",
      },
      provisionedBy: { kind: "self-service" },
    });
    expect(result.tenantId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("passes the input clock through to the audit createdAt", async () => {
    const fixedNow = new Date("2026-06-03T12:00:00Z");
    const result = await provisionTenant(
      { db, now: () => fixedNow },
      {
        orgName: "Clock Co",
        orgType: "club",
        primaryAdmin: {
          email: "clock@example.test",
          password: "long-enough-password",
        },
        provisionedBy: { kind: "self-service" },
      },
    );
    const [audit] = await db
      .select()
      .from(tenantProvisioningAudit)
      .where(eq(tenantProvisioningAudit.id, result.auditId));
    expect(audit?.createdAt.toISOString()).toBe(fixedNow.toISOString());
    expect(audit?.completedAt?.toISOString()).toBe(fixedNow.toISOString());
  });
});

async function seedUser(db: TestDb, email: string): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await passwordHasher.hash("seeded-password"),
      emailVerifiedAt: new Date(),
      passwordChangedAt: new Date(),
    })
    .returning();
  if (!row) throw new Error("seedUser failed");
  return row.id;
}

// Local guard: make sure `sql` import isn't shaken away. (Used in inline
// migrations elsewhere; here it would only show up if the body grows.)
void sql;
