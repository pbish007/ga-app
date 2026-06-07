import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  runAsTenant,
  schema as dbSchema,
  setupTestSuite,
  type TestDb,
} from "@ga/db";
import { passwordHasher, type AccountsDb } from "@ga/accounts";

import {
  loadTeamCredentialSummary,
  selectTenantMemberCredentials,
} from "../lib/credentials/team-list";

const {
  organizationMemberships,
  organizations,
  regimeCredentialTypes,
  regimes,
  userCredentials,
  users,
} = dbSchema;

interface Seed {
  tenantA: string;
  tenantB: string;
  apTypeId: string;
  iaTypeId: string;
  adminA: string;
  mechanicA: string;
  pilotA: string;
  adminB: string;
  mechanicB: string;
  /** Member of both A and B — verifies the join doesn't accidentally double-count. */
  dualMember: string;
}

async function seed(db: TestDb): Promise<Seed> {
  const [faa] = await db.select().from(regimes).where(eq(regimes.code, "FAA"));
  if (!faa) throw new Error("FAA regime seed missing");
  const types = await db
    .select()
    .from(regimeCredentialTypes)
    .where(eq(regimeCredentialTypes.regimeId, faa.id))
    .orderBy(regimeCredentialTypes.name);
  const apType = types[0];
  const iaType = types[1] ?? types[0];
  if (!apType || !iaType) throw new Error("FAA credential types missing");

  const [acme] = await db
    .insert(organizations)
    .values({ name: "Acme", orgType: "shop", defaultRegimeId: faa.id })
    .returning({ id: organizations.id });
  const [beta] = await db
    .insert(organizations)
    .values({ name: "Beta", orgType: "club", defaultRegimeId: faa.id })
    .returning({ id: organizations.id });
  if (!acme || !beta) throw new Error("seed orgs failed");

  const passwordHash = await passwordHasher.hash("strong-test-password");
  async function newUser(email: string): Promise<string> {
    const [u] = await db
      .insert(users)
      .values({ email, passwordHash })
      .returning({ id: users.id });
    if (!u) throw new Error(`seed user ${email} failed`);
    return u.id;
  }
  const adminA = await newUser("a-admin@example.test");
  const mechanicA = await newUser("a-mech@example.test");
  const pilotA = await newUser("a-pilot@example.test");
  const adminB = await newUser("b-admin@example.test");
  const mechanicB = await newUser("b-mech@example.test");
  const dualMember = await newUser("dual@example.test");

  await db.insert(organizationMemberships).values([
    { tenantId: acme.id, userId: adminA, role: "admin" },
    { tenantId: acme.id, userId: mechanicA, role: "mechanic" },
    { tenantId: acme.id, userId: pilotA, role: "pilot" },
    { tenantId: acme.id, userId: dualMember, role: "mechanic" },
    { tenantId: beta.id, userId: adminB, role: "admin" },
    { tenantId: beta.id, userId: mechanicB, role: "mechanic" },
    { tenantId: beta.id, userId: dualMember, role: "pilot" },
  ]);

  return {
    tenantA: acme.id,
    tenantB: beta.id,
    apTypeId: apType.id,
    iaTypeId: iaType.id,
    adminA,
    mechanicA,
    pilotA,
    adminB,
    mechanicB,
    dualMember,
  };
}

async function seedCredential(
  db: TestDb,
  tenantId: string,
  targetUserId: string,
  typeId: string,
  actorUserId: string,
): Promise<void> {
  await runAsTenant(db, tenantId, async (tx) => {
    await tx.insert(userCredentials).values({
      userId: targetUserId,
      regimeCredentialTypeId: typeId,
      issuedOn: "2026-01-01",
      expiresOn: "2099-12-31",
      ratings: ["Airframe"],
      createdByUserId: actorUserId,
    });
  });
}

describe("PMB-174 team-list credential read is tenant-scoped at SQL level", () => {
  let db: TestDb;
  let reset: () => Promise<void>;
  let s: Seed;

  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });
  beforeEach(async () => {
    s = await seed(db);
  });
  afterEach(async () => {
    await reset();
  });

  // ---------------------------------------------------------------------------
  // BOLA regression: the raw SQL must not surface credentials owned by users
  // who are NOT members of the requested tenant. This assertion fires on the
  // SQL surface directly — without it, the JS-side bucketing in
  // `loadTeamCredentialSummary` would mask a SQL-level leak (the original
  // defense-in-depth gap PMB-174 closes).
  // ---------------------------------------------------------------------------

  it("selectTenantMemberCredentials excludes credentials for users not in the tenant", async () => {
    // mechanicA is a member of A and gets a credential.
    await seedCredential(db, s.tenantA, s.mechanicA, s.apTypeId, s.adminA);
    // mechanicB and adminB are members of B ONLY — their credentials must
    // never surface when reading tenant A.
    await seedCredential(db, s.tenantB, s.mechanicB, s.apTypeId, s.adminB);
    await seedCredential(db, s.tenantB, s.adminB, s.iaTypeId, s.adminB);

    const rows = await runAsTenant(db, s.tenantA, async (tx) =>
      selectTenantMemberCredentials(tx as unknown as AccountsDb, s.tenantA),
    );

    const userIds = rows.map((r) => r.userId);
    expect(userIds).toContain(s.mechanicA);
    expect(userIds).not.toContain(s.mechanicB);
    expect(userIds).not.toContain(s.adminB);
  });

  it("selectTenantMemberCredentials returns rows for a user who is a member of the tenant, regardless of which tenant transaction inserted the credential", async () => {
    // dualMember belongs to A and B. Credentials are tenant-agnostic by design;
    // both should appear in A's read because the gate is membership-in-tenant.
    await seedCredential(db, s.tenantA, s.dualMember, s.apTypeId, s.adminA);
    await seedCredential(db, s.tenantB, s.dualMember, s.iaTypeId, s.adminB);

    const rowsA = await runAsTenant(db, s.tenantA, async (tx) =>
      selectTenantMemberCredentials(tx as unknown as AccountsDb, s.tenantA),
    );

    const dualRows = rowsA.filter((r) => r.userId === s.dualMember);
    expect(dualRows).toHaveLength(2);
  });

  it("loadTeamCredentialSummary returns zero rows whose userId is exclusively in tenant B", async () => {
    await seedCredential(db, s.tenantA, s.mechanicA, s.apTypeId, s.adminA);
    await seedCredential(db, s.tenantB, s.mechanicB, s.apTypeId, s.adminB);
    await seedCredential(db, s.tenantB, s.adminB, s.iaTypeId, s.adminB);

    const rows = await runAsTenant(db, s.tenantA, async (tx) =>
      loadTeamCredentialSummary(tx as unknown as AccountsDb, s.tenantA),
    );

    const bOnly = new Set([s.adminB, s.mechanicB]);
    const aOnlyOrDual = rows.filter((r) => !bOnly.has(r.userId));
    expect(rows).toHaveLength(aOnlyOrDual.length);
    expect(rows.find((r) => r.userId === s.mechanicA)?.credentials).toHaveLength(
      1,
    );
  });

  it("revoked credentials are not returned", async () => {
    await runAsTenant(db, s.tenantA, async (tx) => {
      await tx.insert(userCredentials).values({
        userId: s.mechanicA,
        regimeCredentialTypeId: s.apTypeId,
        issuedOn: "2026-01-01",
        expiresOn: "2099-12-31",
        ratings: [],
        createdByUserId: s.adminA,
        revokedAt: new Date(),
      });
    });
    const rows = await runAsTenant(db, s.tenantA, async (tx) =>
      selectTenantMemberCredentials(tx as unknown as AccountsDb, s.tenantA),
    );
    expect(rows).toHaveLength(0);
  });
});
