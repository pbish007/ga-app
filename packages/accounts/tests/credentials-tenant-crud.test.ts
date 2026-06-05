import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  runAsTenant,
  schema as dbSchema,
  setupTestSuite,
  type TestDb,
} from "@ga/db";
import { DEFAULT_REGIME_CODE, RegimeClient } from "@ga/regime";

import {
  CredentialNotFoundError,
  CredentialNotInTenantError,
  CredentialService,
  passwordHasher,
} from "../src/index.js";

const {
  organizationMemberships,
  organizations,
  regimeCredentialTypes,
  userCredentialChanges,
  userCredentials,
  users,
} = dbSchema;

let db: TestDb;
let reset: () => Promise<void>;

let counter = 0;
async function seedUser(): Promise<string> {
  counter += 1;
  const [u] = await db
    .insert(users)
    .values({
      email: `user-${counter}@example.test`,
      passwordHash: await passwordHasher.hash("strong-test-password"),
    })
    .returning({ id: users.id });
  if (!u) throw new Error("seed user failed");
  return u.id;
}

interface World {
  faaRegimeId: string;
  apTypeId: string;
  iaTypeId: string;
  acmeTenant: string;
  acmeAdmin: string;
  acmeMechanic: string;
  beta: { tenant: string; admin: string; mechanic: string };
}

async function bootstrap(): Promise<World> {
  const regimes = new RegimeClient(db);
  const faa = await regimes.getByCode(DEFAULT_REGIME_CODE);
  const types = await db
    .select()
    .from(regimeCredentialTypes)
    .where(eq(regimeCredentialTypes.regimeId, faa.id));
  const ap = types.find((t) => t.authorizesSignoff);
  const ia = types.find((t) => !t.authorizesSignoff) ?? types[1] ?? types[0];
  if (!ap || !ia) throw new Error("expected FAA credential type seed");

  const [acme] = await db
    .insert(organizations)
    .values({ name: "Acme Aviation", orgType: "shop", defaultRegimeId: faa.id })
    .returning({ id: organizations.id });
  const [beta] = await db
    .insert(organizations)
    .values({ name: "Beta Flight Club", orgType: "club", defaultRegimeId: faa.id })
    .returning({ id: organizations.id });
  if (!acme || !beta) throw new Error("seed orgs failed");

  const acmeAdmin = await seedUser();
  const acmeMechanic = await seedUser();
  const betaAdmin = await seedUser();
  const betaMechanic = await seedUser();

  await db.insert(organizationMemberships).values([
    { tenantId: acme.id, userId: acmeAdmin, role: "admin" },
    { tenantId: acme.id, userId: acmeMechanic, role: "mechanic" },
    { tenantId: beta.id, userId: betaAdmin, role: "admin" },
    { tenantId: beta.id, userId: betaMechanic, role: "mechanic" },
  ]);

  return {
    faaRegimeId: faa.id,
    apTypeId: ap.id,
    iaTypeId: ia.id,
    acmeTenant: acme.id,
    acmeAdmin,
    acmeMechanic,
    beta: { tenant: beta.id, admin: betaAdmin, mechanic: betaMechanic },
  };
}

describe("PMB-155 credential tenant-scoped CRUD + audit log", () => {
  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });
  afterEach(async () => {
    await reset();
  });

  describe("createForTenant", () => {
    it("inserts the credential and writes a 'create' audit row in the same tenant tx", async () => {
      const w = await bootstrap();
      const credential = await runAsTenant(db, w.acmeTenant, async (tx) => {
        const svc = new CredentialService(tx);
        return svc.createForTenant({
          tenantId: w.acmeTenant,
          actorUserId: w.acmeAdmin,
          targetUserId: w.acmeMechanic,
          regimeCredentialTypeId: w.apTypeId,
          certificateNumber: "A&P-9001",
          ratings: ["Airframe", "Powerplant"],
          issuedOn: "2026-01-01",
          expiresOn: "2099-12-31",
        });
      });
      expect(credential.userId).toBe(w.acmeMechanic);
      expect(credential.certificateNumber).toBe("A&P-9001");
      expect(credential.ratings).toEqual(["Airframe", "Powerplant"]);
      expect(credential.createdByUserId).toBe(w.acmeAdmin);

      const auditRows = await db
        .select()
        .from(userCredentialChanges)
        .where(eq(userCredentialChanges.userCredentialId, credential.id));
      expect(auditRows).toHaveLength(1);
      const audit = auditRows[0]!;
      expect(audit.tenantId).toBe(w.acmeTenant);
      expect(audit.actorUserId).toBe(w.acmeAdmin);
      expect(audit.targetUserId).toBe(w.acmeMechanic);
      expect(audit.action).toBe("create");
      expect(audit.beforeSnapshot).toBeNull();
      expect(audit.afterSnapshot).toMatchObject({
        certificate_number: "A&P-9001",
        ratings: ["Airframe", "Powerplant"],
        revoked_at: null,
      });
    });

    it("rejects writes when the target user is not a member of the tenant", async () => {
      const w = await bootstrap();
      await expect(
        runAsTenant(db, w.acmeTenant, async (tx) => {
          const svc = new CredentialService(tx);
          return svc.createForTenant({
            tenantId: w.acmeTenant,
            actorUserId: w.acmeAdmin,
            targetUserId: w.beta.mechanic,
            regimeCredentialTypeId: w.apTypeId,
            issuedOn: "2026-01-01",
          });
        }),
      ).rejects.toBeInstanceOf(CredentialNotInTenantError);

      const auditCount = await db.select().from(userCredentialChanges);
      expect(auditCount).toHaveLength(0);
    });
  });

  describe("updateForTenant", () => {
    it("captures before/after snapshots and only patches provided fields", async () => {
      const w = await bootstrap();
      const created = await runAsTenant(db, w.acmeTenant, async (tx) => {
        const svc = new CredentialService(tx);
        return svc.createForTenant({
          tenantId: w.acmeTenant,
          actorUserId: w.acmeAdmin,
          targetUserId: w.acmeMechanic,
          regimeCredentialTypeId: w.apTypeId,
          certificateNumber: "A&P-9001",
          ratings: ["Airframe"],
          issuedOn: "2026-01-01",
          expiresOn: "2099-12-31",
        });
      });

      const updated = await runAsTenant(db, w.acmeTenant, async (tx) => {
        const svc = new CredentialService(tx);
        return svc.updateForTenant({
          tenantId: w.acmeTenant,
          actorUserId: w.acmeAdmin,
          credentialId: created.id,
          ratings: ["Airframe", "Powerplant"],
          expiresOn: "2030-12-31",
        });
      });

      expect(updated.ratings).toEqual(["Airframe", "Powerplant"]);
      expect(updated.expiresOn).toBe("2030-12-31");
      expect(updated.certificateNumber).toBe("A&P-9001"); // untouched

      const audits = await db
        .select()
        .from(userCredentialChanges)
        .where(eq(userCredentialChanges.userCredentialId, created.id))
        .orderBy(userCredentialChanges.createdAt);
      expect(audits.map((a) => a.action)).toEqual(["create", "update"]);
      const updateRow = audits.find((a) => a.action === "update")!;
      expect(updateRow.beforeSnapshot).toMatchObject({
        ratings: ["Airframe"],
        expires_on: "2099-12-31",
      });
      expect(updateRow.afterSnapshot).toMatchObject({
        ratings: ["Airframe", "Powerplant"],
        expires_on: "2030-12-31",
      });
    });

    it("404s when the credential is owned by a user outside the acting tenant", async () => {
      const w = await bootstrap();
      // Beta admin creates a credential for beta's mechanic.
      const betaCredential = await runAsTenant(db, w.beta.tenant, async (tx) => {
        const svc = new CredentialService(tx);
        return svc.createForTenant({
          tenantId: w.beta.tenant,
          actorUserId: w.beta.admin,
          targetUserId: w.beta.mechanic,
          regimeCredentialTypeId: w.apTypeId,
          issuedOn: "2026-01-01",
        });
      });
      // Acme admin tries to patch beta's credential.
      await expect(
        runAsTenant(db, w.acmeTenant, async (tx) => {
          const svc = new CredentialService(tx);
          return svc.updateForTenant({
            tenantId: w.acmeTenant,
            actorUserId: w.acmeAdmin,
            credentialId: betaCredential.id,
            certificateNumber: "HIJACKED",
          });
        }),
      ).rejects.toBeInstanceOf(CredentialNotInTenantError);
    });
  });

  describe("revokeForTenant", () => {
    it("soft-revokes the credential and writes a 'revoke' audit row", async () => {
      const w = await bootstrap();
      const created = await runAsTenant(db, w.acmeTenant, async (tx) => {
        const svc = new CredentialService(tx);
        return svc.createForTenant({
          tenantId: w.acmeTenant,
          actorUserId: w.acmeAdmin,
          targetUserId: w.acmeMechanic,
          regimeCredentialTypeId: w.apTypeId,
          issuedOn: "2026-01-01",
        });
      });
      const at = new Date("2026-03-15T12:00:00Z");
      const revoked = await runAsTenant(db, w.acmeTenant, async (tx) => {
        const svc = new CredentialService(tx);
        return svc.revokeForTenant({
          tenantId: w.acmeTenant,
          actorUserId: w.acmeAdmin,
          credentialId: created.id,
          at,
        });
      });
      expect(revoked.revokedAt?.toISOString()).toBe(at.toISOString());

      const audits = await db
        .select()
        .from(userCredentialChanges)
        .where(eq(userCredentialChanges.userCredentialId, created.id))
        .orderBy(userCredentialChanges.createdAt);
      expect(audits.map((a) => a.action)).toEqual(["create", "revoke"]);
      const revokeRow = audits[1]!;
      expect(revokeRow.beforeSnapshot).toMatchObject({ revoked_at: null });
      expect(revokeRow.afterSnapshot).toMatchObject({
        revoked_at: at.toISOString(),
      });
    });

    it("is idempotent — a second revoke produces no extra audit row", async () => {
      const w = await bootstrap();
      const created = await runAsTenant(db, w.acmeTenant, async (tx) => {
        const svc = new CredentialService(tx);
        return svc.createForTenant({
          tenantId: w.acmeTenant,
          actorUserId: w.acmeAdmin,
          targetUserId: w.acmeMechanic,
          regimeCredentialTypeId: w.apTypeId,
          issuedOn: "2026-01-01",
        });
      });
      await runAsTenant(db, w.acmeTenant, async (tx) => {
        const svc = new CredentialService(tx);
        await svc.revokeForTenant({
          tenantId: w.acmeTenant,
          actorUserId: w.acmeAdmin,
          credentialId: created.id,
        });
        await svc.revokeForTenant({
          tenantId: w.acmeTenant,
          actorUserId: w.acmeAdmin,
          credentialId: created.id,
        });
      });
      const revokeRows = await db
        .select()
        .from(userCredentialChanges)
        .where(
          and(
            eq(userCredentialChanges.userCredentialId, created.id),
            eq(userCredentialChanges.action, "revoke"),
          ),
        );
      expect(revokeRows).toHaveLength(1);
    });
  });

  describe("listForTenantMember + cross-tenant isolation", () => {
    it("returns the member's credentials, newest first", async () => {
      const w = await bootstrap();
      await runAsTenant(db, w.acmeTenant, async (tx) => {
        const svc = new CredentialService(tx);
        await svc.createForTenant({
          tenantId: w.acmeTenant,
          actorUserId: w.acmeAdmin,
          targetUserId: w.acmeMechanic,
          regimeCredentialTypeId: w.apTypeId,
          issuedOn: "2026-01-01",
        });
        await svc.createForTenant({
          tenantId: w.acmeTenant,
          actorUserId: w.acmeAdmin,
          targetUserId: w.acmeMechanic,
          regimeCredentialTypeId: w.iaTypeId,
          issuedOn: "2026-02-01",
        });
      });

      const rows = await runAsTenant(db, w.acmeTenant, async (tx) => {
        const svc = new CredentialService(tx);
        return svc.listForTenantMember({
          tenantId: w.acmeTenant,
          targetUserId: w.acmeMechanic,
        });
      });
      expect(rows).toHaveLength(2);
    });

    it("rejects a cross-tenant read of a non-member's credentials", async () => {
      const w = await bootstrap();
      await runAsTenant(db, w.beta.tenant, async (tx) => {
        const svc = new CredentialService(tx);
        await svc.createForTenant({
          tenantId: w.beta.tenant,
          actorUserId: w.beta.admin,
          targetUserId: w.beta.mechanic,
          regimeCredentialTypeId: w.apTypeId,
          issuedOn: "2026-01-01",
        });
      });

      await expect(
        runAsTenant(db, w.acmeTenant, async (tx) => {
          const svc = new CredentialService(tx);
          return svc.listForTenantMember({
            tenantId: w.acmeTenant,
            targetUserId: w.beta.mechanic,
          });
        }),
      ).rejects.toBeInstanceOf(CredentialNotInTenantError);
    });
  });

  describe("listActiveForTenantMember (signoff-time read)", () => {
    it("hides revoked + expired credentials and joins credential-type metadata", async () => {
      const w = await bootstrap();
      const now = new Date("2026-06-01T00:00:00Z");

      const [valid, expired, revoked] = await runAsTenant(
        db,
        w.acmeTenant,
        async (tx) => {
          const svc = new CredentialService(tx);
          const valid = await svc.createForTenant({
            tenantId: w.acmeTenant,
            actorUserId: w.acmeAdmin,
            targetUserId: w.acmeMechanic,
            regimeCredentialTypeId: w.apTypeId,
            certificateNumber: "A&P-9001",
            ratings: ["Airframe", "Powerplant"],
            issuedOn: "2026-01-01",
            expiresOn: "2099-12-31",
          });
          const expired = await svc.createForTenant({
            tenantId: w.acmeTenant,
            actorUserId: w.acmeAdmin,
            targetUserId: w.acmeMechanic,
            regimeCredentialTypeId: w.iaTypeId,
            issuedOn: "2020-01-01",
            expiresOn: "2024-01-01",
          });
          const revoked = await svc.createForTenant({
            tenantId: w.acmeTenant,
            actorUserId: w.acmeAdmin,
            targetUserId: w.acmeMechanic,
            regimeCredentialTypeId: w.iaTypeId,
            issuedOn: "2025-01-01",
          });
          await svc.revokeForTenant({
            tenantId: w.acmeTenant,
            actorUserId: w.acmeAdmin,
            credentialId: revoked.id,
          });
          return [valid, expired, revoked] as const;
        },
      );

      const active = await runAsTenant(db, w.acmeTenant, async (tx) => {
        const svc = new CredentialService(tx);
        return svc.listActiveForTenantMember({
          tenantId: w.acmeTenant,
          targetUserId: w.acmeMechanic,
          regimeId: w.faaRegimeId,
          now,
        });
      });

      expect(active.map((c) => c.id)).toEqual([valid.id]);
      const card = active[0]!;
      expect(card.credentialTypeCode).toBeTruthy();
      expect(typeof card.authorizesSignoff).toBe("boolean");
      expect(card.certificateNumber).toBe("A&P-9001");
      expect(card.ratings).toEqual(["Airframe", "Powerplant"]);
      // Sanity — the seeded "rejects" referenced above are real rows
      // we explicitly want filtered out.
      expect(expired.id).not.toBe(valid.id);
      expect(revoked.id).not.toBe(valid.id);
    });
  });

  describe("audit log append-only", () => {
    it("forbids UPDATE on user_credential_changes", async () => {
      const w = await bootstrap();
      const created = await runAsTenant(db, w.acmeTenant, async (tx) => {
        const svc = new CredentialService(tx);
        return svc.createForTenant({
          tenantId: w.acmeTenant,
          actorUserId: w.acmeAdmin,
          targetUserId: w.acmeMechanic,
          regimeCredentialTypeId: w.apTypeId,
          issuedOn: "2026-01-01",
        });
      });
      const [row] = await db
        .select()
        .from(userCredentialChanges)
        .where(eq(userCredentialChanges.userCredentialId, created.id));
      expect(row).toBeTruthy();
      await expect(
        db
          .update(userCredentialChanges)
          .set({ action: "update" })
          .where(eq(userCredentialChanges.id, row!.id)),
      ).rejects.toThrow();
    });

    it("missing CHECK keeps a 'create' row from having a before_snapshot", async () => {
      const w = await bootstrap();
      const created = await runAsTenant(db, w.acmeTenant, async (tx) => {
        const svc = new CredentialService(tx);
        return svc.createForTenant({
          tenantId: w.acmeTenant,
          actorUserId: w.acmeAdmin,
          targetUserId: w.acmeMechanic,
          regimeCredentialTypeId: w.apTypeId,
          issuedOn: "2026-01-01",
        });
      });
      await expect(
        db.insert(userCredentialChanges).values({
          tenantId: w.acmeTenant,
          userCredentialId: created.id,
          targetUserId: w.acmeMechanic,
          actorUserId: w.acmeAdmin,
          action: "create",
          beforeSnapshot: { id: created.id },
          afterSnapshot: { id: created.id },
        }),
      ).rejects.toThrow();
    });
  });

  describe("CredentialNotFoundError", () => {
    it("update on a missing credential throws CredentialNotFoundError", async () => {
      const w = await bootstrap();
      await expect(
        runAsTenant(db, w.acmeTenant, async (tx) => {
          const svc = new CredentialService(tx);
          return svc.updateForTenant({
            tenantId: w.acmeTenant,
            actorUserId: w.acmeAdmin,
            credentialId: "00000000-0000-0000-0000-000000000000",
            certificateNumber: "nope",
          });
        }),
      ).rejects.toBeInstanceOf(CredentialNotFoundError);
    });
  });
});
