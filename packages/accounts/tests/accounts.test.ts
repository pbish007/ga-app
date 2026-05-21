import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setupTestDb, type TestDb, schema as dbSchema } from "@ga/db";
import { DEFAULT_REGIME_CODE, RegimeClient } from "@ga/regime";

import {
  InviteError,
  InviteService,
  OrganizationService,
  OutboxMailer,
  passwordHasher,
  renderInviteEmail,
  sendInvitation,
  type Mailer,
  type OutgoingEmail,
} from "../src/index.js";

const { emailOutbox, organizations, organizationMemberships, users } = dbSchema;

async function bootstrap(): Promise<{ db: TestDb; admin: { id: string } }> {
  const db = await setupTestDb();
  // Seed an admin user to act as the inviter — invitations require
  // invited_by_user_id.
  const [admin] = await db
    .insert(users)
    .values({
      email: "founder@example.test",
      passwordHash: await passwordHasher.hash("hunter2-the-strong-one"),
      emailVerifiedAt: new Date(),
      passwordChangedAt: new Date(),
    })
    .returning();
  if (!admin) throw new Error("seed admin");
  return { db, admin };
}

describe("A1.1 accounts schema (PMB-27)", () => {
  describe("schema migration", () => {
    it("creates all five accounts tables on top of the regime spine", async () => {
      const db = await setupTestDb();
      const result = await db.execute<{ table_name: string }>(
        sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
      );
      const tables = result.rows.map((r) => r.table_name);
      for (const expected of [
        "organizations",
        "users",
        "organization_memberships",
        "invitations",
        "email_outbox",
        // regime spine still present from 0001:
        "regimes",
        "regime_credential_types",
      ]) {
        expect(tables, `missing ${expected}`).toContain(expected);
      }
    });

    it("enforces the org_type CHECK and rejects bogus values", async () => {
      const { db } = await bootstrap();
      const regimes = new RegimeClient(db);
      const faa = await regimes.getByCode(DEFAULT_REGIME_CODE);
      // Cast the bogus value through `as any` to bypass the TS union and
      // prove the database CHECK constraint is the real gate. A typo at
      // runtime (e.g. from a poorly-typed boundary) must still be rejected.
      const bogusOrgType = "airline" as unknown as "school";
      await expect(
        db.insert(organizations).values({
          name: "Bad Org",
          orgType: bogusOrgType,
          defaultRegimeId: faa.id,
        }),
      ).rejects.toThrow();
    });

    it("indexes users.email case-insensitively", async () => {
      const { db } = await bootstrap();
      await expect(
        db.insert(users).values({
          email: "FOUNDER@example.test",
          passwordHash: "x",
        }),
      ).rejects.toThrow(/users_email_lower_unique/i);
    });
  });

  describe("OrganizationService", () => {
    it("defaults new orgs to the FAA regime (K2 seam)", async () => {
      const { db } = await bootstrap();
      const orgs = new OrganizationService(db);
      const org = await orgs.create({
        name: "Skyhawk Flying Club",
        orgType: "club",
      });
      const regimes = new RegimeClient(db);
      const faa = await regimes.getByCode(DEFAULT_REGIME_CODE);
      expect(org.defaultRegimeId).toBe(faa.id);
      expect(org.orgType).toBe("club");
    });

    it("accepts an explicit regime override (for future regimes)", async () => {
      const { db } = await bootstrap();
      const regimes = new RegimeClient(db);
      const cars = await regimes.createBundle({
        code: "CARS-TEST",
        name: "Canadian Aviation Regulations (test)",
        jurisdiction: "Canada",
      });
      const orgs = new OrganizationService(db);
      const org = await orgs.create({
        name: "Toronto Maintenance Co.",
        orgType: "shop",
        defaultRegimeId: cars.regime.id,
      });
      expect(org.defaultRegimeId).toBe(cars.regime.id);
    });
  });

  describe("password hasher", () => {
    it("rejects an empty password", async () => {
      await expect(passwordHasher.hash("")).rejects.toThrow(/required/);
    });

    it("round-trips a strong password", async () => {
      const hash = await passwordHasher.hash("correct horse battery staple");
      expect(hash.startsWith("scrypt$")).toBe(true);
      expect(await passwordHasher.verify("correct horse battery staple", hash))
        .toBe(true);
      expect(await passwordHasher.verify("wrong password", hash)).toBe(false);
    });

    it("verify() rejects malformed encoded hashes without throwing", async () => {
      expect(await passwordHasher.verify("p", "not-a-hash")).toBe(false);
      expect(await passwordHasher.verify("p", "bcrypt$abc$def")).toBe(false);
    });
  });

  describe("InviteService", () => {
    it("creates an invite, returns the raw token, persists only its hash", async () => {
      const { db, admin } = await bootstrap();
      const orgs = new OrganizationService(db);
      const org = await orgs.create({ name: "Lakeshore Aero", orgType: "shop" });
      const invites = new InviteService(db);

      const { invitation, rawToken } = await invites.create({
        tenantId: org.id,
        email: "Mechanic@example.test",
        role: "mechanic",
        invitedByUserId: admin.id,
      });

      expect(rawToken).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(invitation.tokenHash).not.toBe(rawToken);
      expect(invitation.tokenHash).toHaveLength(64); // sha256 hex
      expect(invitation.email).toBe("Mechanic@example.test");
      expect(invitation.acceptedAt).toBeNull();
      expect(invitation.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("accept() creates the user, sets the user-chosen password, and joins the org", async () => {
      const { db, admin } = await bootstrap();
      const orgs = new OrganizationService(db);
      const org = await orgs.create({ name: "Bluebird Flight School", orgType: "school" });
      const invites = new InviteService(db);

      const { rawToken } = await invites.create({
        tenantId: org.id,
        email: "pilot@example.test",
        role: "pilot",
        invitedByUserId: admin.id,
      });

      const accepted = await invites.accept({
        rawToken,
        password: "the password they chose themselves",
      });

      expect(accepted.user.email).toBe("pilot@example.test");
      expect(accepted.user.passwordHash).toMatch(/^scrypt\$/);
      expect(
        await passwordHasher.verify(
          "the password they chose themselves",
          accepted.user.passwordHash!,
        ),
      ).toBe(true);
      expect(accepted.membership.role).toBe("pilot");
      expect(accepted.membership.tenantId).toBe(org.id);
      expect(accepted.invitation.acceptedAt).toBeInstanceOf(Date);
    });

    it("rejects token reuse after acceptance", async () => {
      const { db, admin } = await bootstrap();
      const orgs = new OrganizationService(db);
      const org = await orgs.create({ name: "Cardinal Club", orgType: "club" });
      const invites = new InviteService(db);

      const { rawToken } = await invites.create({
        tenantId: org.id,
        email: "double@example.test",
        role: "read_only",
        invitedByUserId: admin.id,
      });
      await invites.accept({ rawToken, password: "first attempt password" });

      await expect(
        invites.accept({ rawToken, password: "second attempt" }),
      ).rejects.toMatchObject({
        name: "InviteError",
        code: "already_accepted",
      });
    });

    it("rejects an expired invitation", async () => {
      const { db, admin } = await bootstrap();
      const orgs = new OrganizationService(db);
      const org = await orgs.create({ name: "Stale Co", orgType: "shop" });
      const invites = new InviteService(db);

      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        const { rawToken } = await invites.create({
          tenantId: org.id,
          email: "stale@example.test",
          role: "mechanic",
          invitedByUserId: admin.id,
          ttlHours: 1,
        });
        vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
        await expect(
          invites.accept({ rawToken, password: "doesn't matter" }),
        ).rejects.toMatchObject({
          name: "InviteError",
          code: "expired",
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects an unknown token", async () => {
      const { db } = await bootstrap();
      const invites = new InviteService(db);
      await expect(
        invites.accept({ rawToken: "definitely-not-a-real-token", password: "p" }),
      ).rejects.toMatchObject({
        name: "InviteError",
        code: "invalid_token",
      });
    });

    it("does not overwrite an existing user's password on second-org invite", async () => {
      const { db, admin } = await bootstrap();
      const orgs = new OrganizationService(db);
      const orgA = await orgs.create({ name: "Org A", orgType: "club" });
      const orgB = await orgs.create({ name: "Org B", orgType: "shop" });
      const invites = new InviteService(db);

      const first = await invites.create({
        tenantId: orgA.id,
        email: "multi@example.test",
        role: "pilot",
        invitedByUserId: admin.id,
      });
      const accepted = await invites.accept({
        rawToken: first.rawToken,
        password: "the original password",
      });
      const originalHash = accepted.user.passwordHash!;

      const second = await invites.create({
        tenantId: orgB.id,
        email: "multi@example.test",
        role: "mechanic",
        invitedByUserId: admin.id,
      });
      const acceptedTwo = await invites.accept({
        rawToken: second.rawToken,
        password: "a different password",
      });
      expect(acceptedTwo.user.id).toBe(accepted.user.id);
      expect(acceptedTwo.user.passwordHash).toBe(originalHash);
      expect(
        await passwordHasher.verify("the original password", acceptedTwo.user.passwordHash!),
      ).toBe(true);
    });

    it("rejects a duplicate membership", async () => {
      const { db, admin } = await bootstrap();
      const orgs = new OrganizationService(db);
      const org = await orgs.create({ name: "Dup Co", orgType: "club" });
      const invites = new InviteService(db);
      const first = await invites.create({
        tenantId: org.id,
        email: "dup@example.test",
        role: "pilot",
        invitedByUserId: admin.id,
      });
      await invites.accept({ rawToken: first.rawToken, password: "first-password" });

      const second = await invites.create({
        tenantId: org.id,
        email: "dup@example.test",
        role: "manager",
        invitedByUserId: admin.id,
      });
      await expect(
        invites.accept({ rawToken: second.rawToken, password: "second-password" }),
      ).rejects.toMatchObject({
        name: "InviteError",
        code: "duplicate_membership",
      });
    });
  });

  describe("OutboxMailer + sendInvitation", () => {
    it("enqueues the invite email in email_outbox without calling SMTP", async () => {
      const { db, admin } = await bootstrap();
      const orgs = new OrganizationService(db);
      const org = await orgs.create({ name: "Outbox Aero", orgType: "club" });
      const invites = new InviteService(db);
      const mailer = new OutboxMailer(db);

      await sendInvitation(
        {
          inviteService: invites,
          mailer,
          acceptUrlBase: "https://app.example.test/invitations",
          resolveOrganizationName: async () => org.name,
        },
        {
          tenantId: org.id,
          email: "newbie@example.test",
          role: "pilot",
          invitedByUserId: admin.id,
        },
      );

      const queued = await db.select().from(emailOutbox);
      expect(queued).toHaveLength(1);
      const row = queued[0]!;
      expect(row.recipientEmail).toBe("newbie@example.test");
      expect(row.status).toBe("pending");
      expect(row.subject).toContain("Outbox Aero");
      expect(row.bodyText).toContain("https://app.example.test/invitations/");
      expect(row.bodyHtml).toMatch(/<a href=/);
      expect(row.tenantId).toBe(org.id);
      expect(row.sentAt).toBeNull();
    });

    it("uses the Mailer interface (not the outbox) when callers inject a stub", async () => {
      const { db, admin } = await bootstrap();
      const orgs = new OrganizationService(db);
      const org = await orgs.create({ name: "Stub Co", orgType: "club" });
      const invites = new InviteService(db);

      const sent: OutgoingEmail[] = [];
      const stub: Mailer = { send: async (m) => void sent.push(m) };

      await sendInvitation(
        {
          inviteService: invites,
          mailer: stub,
          acceptUrlBase: "https://example/i",
          resolveOrganizationName: async () => "Stub Co",
        },
        {
          tenantId: org.id,
          email: "anyone@example.test",
          role: "manager",
          invitedByUserId: admin.id,
        },
      );

      expect(sent).toHaveLength(1);
      expect(sent[0]?.bodyText).toContain("manager");
      const queued = await db.select().from(emailOutbox);
      expect(queued).toHaveLength(0);
    });

    it("renderInviteEmail is regime-agnostic and includes no regulatory text", () => {
      const rendered = renderInviteEmail({
        invitation: {
          id: "00000000-0000-0000-0000-000000000000",
          tenantId: "00000000-0000-0000-0000-000000000000",
          email: "x@example.test",
          role: "mechanic",
          invitedByUserId: "00000000-0000-0000-0000-000000000000",
          tokenHash: "deadbeef",
          expiresAt: new Date("2026-12-31T00:00:00Z"),
          acceptedAt: null,
          createdAt: new Date("2026-05-20T00:00:00Z"),
          updatedAt: new Date("2026-05-20T00:00:00Z"),
        },
        rawToken: "rT-1",
        organizationName: "Test Org",
        acceptUrlBase: "https://example/invitations",
      });
      expect(rendered.bodyText).not.toMatch(/14 CFR|FAA|airworthy|return to service/i);
      expect(rendered.bodyHtml).not.toMatch(/14 CFR|FAA|airworthy|return to service/i);
      expect(rendered.subject).toBe("You're invited to Test Org");
    });
  });
});

afterEach(() => {
  vi.useRealTimers();
});
