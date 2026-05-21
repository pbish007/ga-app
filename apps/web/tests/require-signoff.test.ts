import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import {
  APP_ROLE_CODES,
  schema as dbSchema,
  setupTestDb,
  type TestDb,
  type AppRoleCode,
} from "@ga/db";
import {
  CredentialService,
  attachPermissions,
  loadPermissionsMatrix,
  passwordHasher,
  type MembershipWithPermissions,
  type PermissionsMatrix,
} from "@ga/accounts";

import { requireSignoff } from "../lib/auth";

const { regimes, regimeCredentialTypes, users } = dbSchema;

interface Seeded {
  db: TestDb;
  matrix: PermissionsMatrix;
  service: CredentialService;
  faaId: string;
  apTypeId: string;
  userId: string;
}

function synthMembership(
  userId: string,
  role: AppRoleCode,
  matrix: PermissionsMatrix,
): MembershipWithPermissions {
  return attachPermissions(
    {
      id: "00000000-0000-0000-0000-000000000000",
      tenantId: "00000000-0000-0000-0000-000000000000",
      userId,
      role,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    matrix,
  );
}

async function bootstrap(): Promise<Seeded> {
  const db = await setupTestDb();
  const [faa] = await db.select().from(regimes).where(eq(regimes.code, "FAA"));
  if (!faa) throw new Error("FAA regime seed missing");
  const [ap] = await db
    .select()
    .from(regimeCredentialTypes)
    .where(eq(regimeCredentialTypes.regimeId, faa.id));
  if (!ap) throw new Error("FAA credential types missing");
  const matrix = await loadPermissionsMatrix(db);
  const [user] = await db
    .insert(users)
    .values({
      email: "mechanic@example.test",
      passwordHash: await passwordHasher.hash("a strong test password"),
    })
    .returning();
  if (!user) throw new Error("seed user failed");
  return {
    db,
    matrix,
    service: new CredentialService(db),
    faaId: faa.id,
    apTypeId: ap.id,
    userId: user.id,
  };
}

/**
 * Create a synthetic CARS regime by writing directly to `regimes` and
 * `regime_credential_types`. apps/web depends on `@ga/db` and `@ga/accounts`
 * — RegimeClient lives in `@ga/regime`, which we deliberately do not pull
 * into the web app's dep graph for one test.
 */
async function seedCarsRegime(
  db: TestDb,
  opts: { code: string; ameAuthorizes?: boolean } = { code: "CARS" },
): Promise<{ regimeId: string; ameTypeId: string }> {
  const [regime] = await db
    .insert(regimes)
    .values({
      code: opts.code,
      name: "Canadian Aviation Regulations (test)",
      jurisdiction: "Canada",
    })
    .returning();
  if (!regime) throw new Error("seed CARS regime failed");
  const [ame] = await db
    .insert(regimeCredentialTypes)
    .values({
      regimeId: regime.id,
      code: "ame",
      name: "Aircraft Maintenance Engineer",
      authorizesSignoff: opts.ameAuthorizes ?? true,
    })
    .returning();
  if (!ame) throw new Error("seed AME credential type failed");
  return { regimeId: regime.id, ameTypeId: ame.id };
}

describe("requireSignoff guard (PMB-34)", () => {
  let s: Seeded;
  beforeEach(async () => {
    s = await bootstrap();
  });

  it("403 when the role is mechanic but no credential is on file", async () => {
    const res = await requireSignoff(
      {
        userId: s.userId,
        membership: synthMembership(s.userId, "mechanic", s.matrix),
        regimeId: s.faaId,
      },
      { credentials: s.service },
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("null (authorized) when the mechanic holds a valid A&P credential", async () => {
    await s.service.add({
      userId: s.userId,
      regimeCredentialTypeId: s.apTypeId,
      issuedOn: "2024-01-01",
      expiresOn: "2099-12-31",
    });
    const res = await requireSignoff(
      {
        userId: s.userId,
        membership: synthMembership(s.userId, "mechanic", s.matrix),
        regimeId: s.faaId,
      },
      { credentials: s.service },
    );
    expect(res).toBeNull();
  });

  it("403 once the credential expires", async () => {
    await s.service.add({
      userId: s.userId,
      regimeCredentialTypeId: s.apTypeId,
      issuedOn: "2020-01-01",
      expiresOn: "2024-01-01",
    });
    const res = await requireSignoff(
      {
        userId: s.userId,
        membership: synthMembership(s.userId, "mechanic", s.matrix),
        regimeId: s.faaId,
        now: new Date("2025-06-01T00:00:00Z"),
      },
      { credentials: s.service },
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("403 for every non-mechanic role, even with a valid credential", async () => {
    // Issue a credential to prove the gate cares about the role, not
    // just the credential. Spec §4 Epic A AC: only mechanic can sign off.
    await s.service.add({
      userId: s.userId,
      regimeCredentialTypeId: s.apTypeId,
      issuedOn: "2024-01-01",
      expiresOn: "2099-12-31",
    });
    const nonMechanic = APP_ROLE_CODES.filter((r) => r !== "mechanic");
    for (const role of nonMechanic) {
      const res = await requireSignoff(
        {
          userId: s.userId,
          membership: synthMembership(s.userId, role, s.matrix),
          regimeId: s.faaId,
        },
        { credentials: s.service },
      );
      expect(res, `role=${role}`).not.toBeNull();
      expect(res!.status, `role=${role}`).toBe(403);
    }
  });

  it("403 cross-regime — a CARS AME credential does not authorize FAA sign-off", async () => {
    const cars = await seedCarsRegime(s.db);
    await s.service.add({
      userId: s.userId,
      regimeCredentialTypeId: cars.ameTypeId,
      issuedOn: "2024-01-01",
    });

    // Mechanic + valid CARS credential, asking about CARS → authorized.
    const carsRes = await requireSignoff(
      {
        userId: s.userId,
        membership: synthMembership(s.userId, "mechanic", s.matrix),
        regimeId: cars.regimeId,
      },
      { credentials: s.service },
    );
    expect(carsRes).toBeNull();

    // Same user, asking about FAA → 403 (no FAA credential on file).
    const faaRes = await requireSignoff(
      {
        userId: s.userId,
        membership: synthMembership(s.userId, "mechanic", s.matrix),
        regimeId: s.faaId,
      },
      { credentials: s.service },
    );
    expect(faaRes).not.toBeNull();
    expect(faaRes!.status).toBe(403);
  });
});
