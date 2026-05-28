import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  schema as dbSchema,
  setupTestSuite,
  type Regime,
  type RegimeCredentialType,
  type TestDb,
} from "@ga/db";
import { DEFAULT_REGIME_CODE, RegimeClient } from "@ga/regime";

import { CredentialService, passwordHasher } from "../src/index.js";

const { regimeCredentialTypes, users } = dbSchema;

interface Seeded {
  db: TestDb;
  service: CredentialService;
  regimes: RegimeClient;
  faa: Regime;
  ap: RegimeCredentialType;
  userId: string;
}

let userEmailCounter = 0;
async function seedUser(db: TestDb): Promise<string> {
  userEmailCounter += 1;
  const [user] = await db
    .insert(users)
    .values({
      email: `mechanic-${userEmailCounter}@example.test`,
      passwordHash: await passwordHasher.hash("a strong test password"),
    })
    .returning();
  if (!user) throw new Error("seed user failed");
  return user.id;
}

let db: TestDb;
let reset: () => Promise<void>;

async function bootstrap(): Promise<Seeded> {
  const regimes = new RegimeClient(db);
  const faa = await regimes.getByCode(DEFAULT_REGIME_CODE);
  const [ap] = await db
    .select()
    .from(regimeCredentialTypes)
    .where(eq(regimeCredentialTypes.regimeId, faa.id));
  if (!ap) throw new Error("FAA credential types missing");
  const userId = await seedUser(db);
  return { db, service: new CredentialService(db), regimes, faa, ap, userId };
}

describe("A2.3 credential-gated sign-off (PMB-34)", () => {
  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });
  afterEach(async () => {
    await reset();
  });

  describe("CredentialService.canSignOff (FAA)", () => {
    it("returns false for a mechanic with no credential", async () => {
      const { service, faa, userId } = await bootstrap();
      expect(await service.canSignOff(userId, { regimeId: faa.id })).toBe(false);
    });

    it("returns true for a mechanic with a valid A&P credential", async () => {
      const { service, faa, ap, userId } = await bootstrap();
      await service.add({
        userId,
        regimeCredentialTypeId: ap.id,
        certificateNumber: "A&P-1234567",
        issuedOn: "2024-01-01",
        expiresOn: "2099-12-31",
      });
      expect(await service.canSignOff(userId, { regimeId: faa.id })).toBe(true);
    });

    it("returns false again after the credential expires", async () => {
      const { service, faa, ap, userId } = await bootstrap();
      await service.add({
        userId,
        regimeCredentialTypeId: ap.id,
        issuedOn: "2020-01-01",
        expiresOn: "2024-01-01",
      });
      expect(
        await service.canSignOff(userId, {
          regimeId: faa.id,
          now: new Date("2025-06-01T00:00:00Z"),
        }),
      ).toBe(false);
    });

    it("returns false again after revoke", async () => {
      const { service, faa, ap, userId } = await bootstrap();
      const cred = await service.add({
        userId,
        regimeCredentialTypeId: ap.id,
        issuedOn: "2024-01-01",
      });
      expect(await service.canSignOff(userId, { regimeId: faa.id })).toBe(true);
      await service.revoke(cred.id);
      expect(await service.canSignOff(userId, { regimeId: faa.id })).toBe(false);
    });

    it("treats a NULL expiry as 'never expires' (FAA A&P)", async () => {
      const { service, faa, ap, userId } = await bootstrap();
      await service.add({
        userId,
        regimeCredentialTypeId: ap.id,
        issuedOn: "2020-01-01",
      });
      expect(
        await service.canSignOff(userId, {
          regimeId: faa.id,
          now: new Date("2099-12-31T00:00:00Z"),
        }),
      ).toBe(true);
    });

    it("ignores credential types whose authorizes_signoff is false", async () => {
      // Add a non-authorizing type to FAA — a synthetic 'student'
      // credential — and confirm holding only that type fails the gate.
      const { db, service, faa, userId } = await bootstrap();
      const [student] = await db
        .insert(regimeCredentialTypes)
        .values({
          regimeId: faa.id,
          code: "student",
          name: "Student (test-only)",
          authorizesSignoff: false,
        })
        .returning();
      if (!student) throw new Error("seed student cred type failed");
      await service.add({
        userId,
        regimeCredentialTypeId: student.id,
        issuedOn: "2024-01-01",
      });
      expect(await service.canSignOff(userId, { regimeId: faa.id })).toBe(false);
    });

    it("does NOT consult credential-code strings — sign-off authority is the type row", async () => {
      // Toggle the FAA A&P row to authorizes_signoff=false at runtime
      // and confirm the gate flips. If the code switched on the 'ap'
      // string this test would fail.
      const { db, service, faa, ap, userId } = await bootstrap();
      await service.add({
        userId,
        regimeCredentialTypeId: ap.id,
        issuedOn: "2024-01-01",
      });
      expect(await service.canSignOff(userId, { regimeId: faa.id })).toBe(true);

      await db
        .update(regimeCredentialTypes)
        .set({ authorizesSignoff: false })
        .where(eq(regimeCredentialTypes.id, ap.id));
      expect(await service.canSignOff(userId, { regimeId: faa.id })).toBe(false);
    });
  });

  describe("canSignOff is regime-data-driven (synthetic CARS)", () => {
    it("returns true under a synthetic CARS regime when the AME type authorizes sign-off", async () => {
      const { db, regimes } = await bootstrap();
      const cars = await regimes.createBundle({
        code: "CARS",
        name: "Canadian Aviation Regulations",
        jurisdiction: "Canada",
        credentialTypes: [
          {
            code: "ame",
            name: "Aircraft Maintenance Engineer",
            authorizesSignoff: true,
          },
          {
            code: "trainee",
            name: "Trainee (no sign-off)",
            authorizesSignoff: false,
          },
        ],
      });
      const ame = cars.credentialTypes.find((c) => c.authorizesSignoff)!;
      const trainee = cars.credentialTypes.find((c) => !c.authorizesSignoff)!;
      const service = new CredentialService(db);
      const userId = await seedUser(db);

      // No credentials → false.
      expect(await service.canSignOff(userId, { regimeId: cars.regime.id })).toBe(false);

      // Holding only the non-authorizing type → still false.
      await service.add({
        userId,
        regimeCredentialTypeId: trainee.id,
        issuedOn: "2024-01-01",
      });
      expect(await service.canSignOff(userId, { regimeId: cars.regime.id })).toBe(false);

      // Add the authorizing type → true.
      const cred = await service.add({
        userId,
        regimeCredentialTypeId: ame.id,
        issuedOn: "2024-01-01",
        expiresOn: "2099-12-31",
      });
      expect(await service.canSignOff(userId, { regimeId: cars.regime.id })).toBe(true);

      // Revoke → false again.
      await service.revoke(cred.id);
      expect(await service.canSignOff(userId, { regimeId: cars.regime.id })).toBe(false);
    });

    it("does not bleed across regimes — a CARS credential cannot sign off FAA", async () => {
      const { db, regimes, faa } = await bootstrap();
      const cars = await regimes.createBundle({
        code: "CARS-X",
        name: "Canadian Aviation Regulations (cross-regime test)",
        jurisdiction: "Canada",
        credentialTypes: [
          { code: "ame", name: "AME", authorizesSignoff: true },
        ],
      });
      const ame = cars.credentialTypes[0]!;
      const service = new CredentialService(db);
      const userId = await seedUser(db);
      await service.add({
        userId,
        regimeCredentialTypeId: ame.id,
        issuedOn: "2024-01-01",
      });
      expect(await service.canSignOff(userId, { regimeId: cars.regime.id })).toBe(true);
      expect(await service.canSignOff(userId, { regimeId: faa.id })).toBe(false);
    });
  });

  describe("schema invariants", () => {
    it("partial index keeps the active-credential set queryable after revoke", async () => {
      const { service, ap, userId } = await bootstrap();
      const a = await service.add({
        userId,
        regimeCredentialTypeId: ap.id,
        issuedOn: "2024-01-01",
      });
      await service.add({
        userId,
        regimeCredentialTypeId: ap.id,
        issuedOn: "2024-06-01",
      });
      // Two active rows is allowed — list() returns only non-revoked.
      const active = await service.list(userId);
      expect(active).toHaveLength(2);
      await service.revoke(a.id);
      const stillActive = await service.list(userId);
      expect(stillActive).toHaveLength(1);
    });
  });
});
