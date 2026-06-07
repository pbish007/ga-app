import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import {
  schema as dbSchema,
  setupTestSuite,
  type TestDb,
} from "@ga/db";
import { passwordHasher } from "@ga/accounts";
import {
  DocumentsService,
  MemoryBlobDriver,
} from "@ga/storage";

import {
  SESSION_COOKIE_NAME,
  createSessionCookieValue,
} from "../lib/auth";
import {
  handleCommitImport,
  handleCreateImport,
  handleGetImport,
  handleParseImport,
  type AdminImportsDeps,
} from "../lib/admin/imports-handler";

/**
 * PMB-164 / C8 — QA acceptance scenarios on a representative Part 91/145
 * operator dataset.
 *
 * Covers every acceptance criterion in PMB-164:
 *   C8.1  Aircraft master import (8 representative aircraft)
 *   C8.2  Full maintenance log — 18 records spanning 5+ years (2020-2025)
 *   C8.3  Components / life-limited parts (engine, propeller, appliance)
 *   C8.4  Flight time entries (monotonically increasing per aircraft)
 *   C8.5  Malformed-row commit gate (parse=ready/invalid; commit=422)
 *   C8.6  Idempotent retry (second commit → alreadyCommitted, no duplicates)
 *   C8.7  Row-level traceability chain
 *         maintenance_entry.source_import_row_id
 *           → import_job_rows.import_job_id
 *           → import_jobs.source_document_id
 *           → documents.object_key
 *   C8.8  RLS tenant isolation (tenant_app under tenant B cannot see
 *         tenant A's import_jobs or import_job_rows)
 *
 * All suites run against pglite (in-memory) per the "smoke against pglite
 * for fast loop" acceptance requirement.
 */

const {
  aircraft,
  documents,
  importJobs,
  importJobRows,
  maintenanceEntries,
  components,
  flightTimeEntries,
  organizationMemberships,
  organizations,
  platformAdmins,
  regimeCredentialTypes,
  regimes,
  userCredentials,
  users,
} = dbSchema;

const TENANT_APP_ROLE = "tenant_app";
const SECRET =
  "test-only-secret-test-only-secret-test-only-secret-32+bytes";
const MECHANIC_CERT_NUMBER = "IA999111";

let db: TestDb;
let reset: () => Promise<void>;

interface Seed {
  adminUserId: string;
  mechanicUserId: string;
  tenantAId: string;
  tenantBId: string;
  regimeId: string;
}

async function seed(): Promise<Seed> {
  const hash = await passwordHasher.hash("correct horse battery staple");

  const [admin] = await db
    .insert(users)
    .values([{ email: "admin@platform.test", passwordHash: hash }])
    .returning();
  if (!admin) throw new Error("seed admin failed");

  await db.insert(platformAdmins).values({ userId: admin.id, note: "qa seed" });

  const [mechanic] = await db
    .insert(users)
    .values([{ email: "mechanic@shop.test", passwordHash: hash }])
    .returning();
  if (!mechanic) throw new Error("seed mechanic failed");

  const [faa] = await db.select().from(regimes).where(eq(regimes.code, "FAA"));
  if (!faa) throw new Error("FAA regime not seeded");

  // Two tenants so the RLS isolation scenario can test cross-tenant opacity.
  const [orgA] = await db
    .insert(organizations)
    .values({
      name: "Part 91 Operator",
      orgType: "club",
      defaultRegimeId: faa.id,
    })
    .returning();
  const [orgB] = await db
    .insert(organizations)
    .values({
      name: "Part 145 Shop",
      orgType: "club",
      defaultRegimeId: faa.id,
    })
    .returning();
  if (!orgA || !orgB) throw new Error("seed orgs failed");

  await db.insert(organizationMemberships).values([
    { tenantId: orgA.id, userId: admin.id, role: "admin" },
    { tenantId: orgA.id, userId: mechanic.id, role: "mechanic" },
  ]);

  // Mechanic holds an active IA credential — required by the maintenance
  // entry validator (signedByCertificateNumber must resolve).
  const [iaType] = await db
    .select({ id: regimeCredentialTypes.id })
    .from(regimeCredentialTypes)
    .where(
      sql`${regimeCredentialTypes.regimeId} = ${faa.id} and ${regimeCredentialTypes.code} = 'ia'`,
    )
    .limit(1);
  if (!iaType) throw new Error("IA credential type not seeded");

  await db.insert(userCredentials).values({
    userId: mechanic.id,
    regimeCredentialTypeId: iaType.id,
    certificateNumber: MECHANIC_CERT_NUMBER,
    issuedOn: "2015-03-01",
  });

  return {
    adminUserId: admin.id,
    mechanicUserId: mechanic.id,
    tenantAId: orgA.id,
    tenantBId: orgB.id,
    regimeId: faa.id,
  };
}

function buildDeps(): AdminImportsDeps {
  const documentsService = new DocumentsService(db, new MemoryBlobDriver(), "memory");
  return { db, directDb: db, documentsService, secret: SECRET };
}

function authed(userId: string): { cookie: string } {
  const cookie = createSessionCookieValue(
    { userId, iat: Math.floor(Date.now() / 1000) },
    SECRET,
  );
  return { cookie: `${SESSION_COOKIE_NAME}=${cookie}` };
}

const BASE = "https://app.example.test";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 8 representative Part 91/145 fleet aircraft. */
const AIRCRAFT_CSV = `Tail,Make,Model,Serial,Year,Hours
N12345,Cessna,172S,C17201234,2005,3451.2
N67890,Piper,PA-28-181,28-8490082,1984,5210.7
N54321,Cirrus,SR22,0459,2018,1200.5
N99999,Beechcraft,A36 Bonanza,E-3421,1999,4100.0
N11111,Cessna,182T,18282041,2007,2870.3
N22222,Piper,PA-32-301,32-8006035,1980,6320.1
N33333,Diamond,DA40-XLS,D4.286,2016,980.0
N44444,Mooney,M20J,24-1234,1996,4800.9
`;

const AIRCRAFT_MAPPING_CONFIG = {
  version: "1",
  targetTable: "aircraft",
  columns: {
    registration: { source: "Tail" },
    make: { source: "Make" },
    model: { source: "Model" },
    serialNumber: { source: "Serial" },
    yearManufactured: { source: "Year", format: { kind: "integer" } },
    airframeTotalTime: { source: "Hours", format: { kind: "decimal" } },
  },
  constants: {
    category: "standard",
    aircraftClass: "airplane",
    timeSource: "hobbs",
  },
  lookups: [{ kind: "regime_by_code", target: "regimeId", value: "FAA" }],
} as const;

/**
 * 18 maintenance entries for N77400 spanning 2020-2025 (5+ year log).
 * All rows are fully signed — the import path forbids unsigned historical
 * entries per PMB-160.
 */
const MAINT_CSV = `Tail,Type,Work,Date,TotalTime,SignedAt,CertNumber,RtsCode
N77400,annual_inspection,Annual inspection per FAR 43 Appendix D,2020-09-15,3200.0,2020-09-15T17:00:00Z,${MECHANIC_CERT_NUMBER},annual
N77400,maintenance,Oil change — Aeroshell 15W50 8 qt,2021-01-10,3320.5,2021-01-10T14:30:00Z,${MECHANIC_CERT_NUMBER},return_to_service_maintenance
N77400,maintenance,Spark plug inspection and rotation,2021-03-22,3390.0,2021-03-22T15:00:00Z,${MECHANIC_CERT_NUMBER},return_to_service_maintenance
N77400,100_hour_inspection,100-hour inspection per FAR 43 Appendix D,2021-05-05,3400.0,2021-05-05T16:00:00Z,${MECHANIC_CERT_NUMBER},100_hour
N77400,maintenance,Carburetor heat box repair,2021-08-14,3487.5,2021-08-14T12:00:00Z,${MECHANIC_CERT_NUMBER},return_to_service_maintenance
N77400,annual_inspection,Annual inspection per FAR 43 Appendix D,2021-09-18,3510.0,2021-09-18T17:30:00Z,${MECHANIC_CERT_NUMBER},annual
N77400,ad_compliance,AD 2021-23-14 propeller blade inspection,2021-10-02,3535.0,2021-10-02T11:00:00Z,${MECHANIC_CERT_NUMBER},ad_compliance
N77400,maintenance,Brake pads replacement Cleveland 066-10600,2022-01-15,3620.0,2022-01-15T09:30:00Z,${MECHANIC_CERT_NUMBER},return_to_service_maintenance
N77400,100_hour_inspection,100-hour inspection per FAR 43 Appendix D,2022-04-08,3710.0,2022-04-08T16:00:00Z,${MECHANIC_CERT_NUMBER},100_hour
N77400,maintenance,ELT battery replacement ACK E-04 SN 2022-0142,2022-05-20,3760.5,2022-05-20T10:00:00Z,${MECHANIC_CERT_NUMBER},return_to_service_maintenance
N77400,annual_inspection,Annual inspection per FAR 43 Appendix D,2022-09-25,3850.0,2022-09-25T17:00:00Z,${MECHANIC_CERT_NUMBER},annual
N77400,maintenance,Alternator overhaul Plane Power AL12-C60,2023-02-12,3940.0,2023-02-12T14:00:00Z,${MECHANIC_CERT_NUMBER},return_to_service_maintenance
N77400,100_hour_inspection,100-hour inspection per FAR 43 Appendix D,2023-05-19,4020.0,2023-05-19T16:00:00Z,${MECHANIC_CERT_NUMBER},100_hour
N77400,annual_inspection,Annual inspection per FAR 43 Appendix D,2023-09-30,4120.0,2023-09-30T17:00:00Z,${MECHANIC_CERT_NUMBER},annual
N77400,maintenance,Landing gear retract mechanism lubrication,2024-01-08,4195.0,2024-01-08T10:00:00Z,${MECHANIC_CERT_NUMBER},return_to_service_maintenance
N77400,100_hour_inspection,100-hour inspection per FAR 43 Appendix D,2024-04-15,4280.0,2024-04-15T16:00:00Z,${MECHANIC_CERT_NUMBER},100_hour
N77400,ad_compliance,AD 2024-08-05 engine mount inspection,2024-06-20,4340.0,2024-06-20T11:00:00Z,${MECHANIC_CERT_NUMBER},ad_compliance
N77400,annual_inspection,Annual inspection per FAR 43 Appendix D,2024-10-05,4420.0,2024-10-05T17:00:00Z,${MECHANIC_CERT_NUMBER},annual
`;

const MAINT_MAPPING_CONFIG = {
  version: "1",
  targetTable: "maintenance_entries",
  columns: {
    entryType: { source: "Type" },
    workPerformed: { source: "Work" },
    performedOn: { source: "Date", format: { kind: "date" } },
    aircraftTotalTime: { source: "TotalTime", format: { kind: "decimal" } },
    signedAt: { source: "SignedAt", format: { kind: "datetime" } },
    signedByCertificateNumber: { source: "CertNumber" },
    rtsTemplateCode: { source: "RtsCode" },
  },
  lookups: [
    { kind: "aircraft_by_registration", target: "aircraftId", sourceColumn: "Tail" },
  ],
} as const;

/** 6 components: 2 engines, 2 propellers, 2 appliances. */
const COMPONENTS_CSV = `Kind,Serial,Make,Model,TBOHours,TBOMonths,CycleLimit
engine,ENG-IO550-001,Continental,IO-550-N,2000,,
engine,ENG-IO360-002,Lycoming,IO-360-A1B6,2000,,
propeller,PROP-PHC-001,Hartzell,PHC-J3YF-1RF,2400,96,
propeller,PROP-PHC-002,Hartzell,PHC-J3YF-1RF,2400,96,
appliance,ELT-ACK-001,ACK,E-04,,,
appliance,ELT-ACK-002,ACK,E-04,,,
`;

const COMPONENTS_MAPPING_CONFIG = {
  version: "1",
  targetTable: "components",
  columns: {
    kind: { source: "Kind" },
    serialNumber: { source: "Serial" },
    make: { source: "Make" },
    model: { source: "Model" },
    tboHours: { source: "TBOHours", format: { kind: "decimal" } },
    tboCalendarMonths: { source: "TBOMonths", format: { kind: "integer" } },
    cycleLimit: { source: "CycleLimit", format: { kind: "integer" } },
  },
} as const;

/** 12 flight time entries for two aircraft — strictly monotonic within each. */
const FLIGHT_TIME_CSV = `Tail,Hours
N55500,100.0
N55500,150.5
N55500,200.0
N55500,250.3
N55500,300.8
N55500,350.0
N66600,50.0
N66600,100.2
N66600,150.7
N66600,200.0
N66600,250.5
N66600,300.9
`;

const FLIGHT_TIME_MAPPING_CONFIG = {
  version: "1",
  targetTable: "flight_time_entries",
  columns: {
    airframeTimeNew: { source: "Hours", format: { kind: "decimal" } },
  },
  lookups: [
    { kind: "aircraft_by_registration", target: "aircraftId", sourceColumn: "Tail" },
  ],
} as const;

/**
 * CSV with intentionally malformed rows that MUST be rejected by the
 * per-entity validators. The job state will be "ready" with invalid rows
 * counted, and commit must be blocked.
 *
 * Bad rows:
 *   row 2 — invalid N-number ("ZZBAD" does not match FAA N-number grammar)
 *   row 3 — negative airframeTotalTime (-10) → OUT_OF_RANGE
 *   rows 1 and 4 — valid (prove the gate is per-row, not per-job)
 *
 * Year column is included to match the AIRCRAFT_MAPPING_CONFIG column set.
 */
const MALFORMED_AIRCRAFT_CSV = `Tail,Make,Model,Serial,Year,Hours
N12345,Cessna,172S,SN-OK,2005,1234.5
ZZBAD,Cessna,172S,SN-FAIL,2010,500.0
N67890,Piper,PA28,SN-NEG,1984,-10.0
N99000,Beechcraft,Bonanza,SN-GOOD,1999,2000.0
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedAircraftDirectly(
  tenantId: string,
  regimeId: string,
  registrations: string[],
): Promise<void> {
  for (const reg of registrations) {
    await db.insert(aircraft).values({
      tenantId,
      regimeId,
      registration: reg,
      make: "Test",
      model: "TestModel",
      serialNumber: `SN-${reg}`,
      category: "standard",
      aircraftClass: "airplane",
      airframeTotalTime: "0",
      timeSource: "hobbs",
    });
  }
}

async function runUpload(
  deps: AdminImportsDeps,
  adminUserId: string,
  tenantId: string,
  csvContent: string,
  filename: string,
  targetTable: string,
  mappingConfig: object,
): Promise<{ importJobId: string; documentId: string }> {
  const form = new FormData();
  form.set("file", new File([csvContent], filename, { type: "text/csv" }));
  form.set("tenant_id", tenantId);
  form.set("target_table", targetTable);
  form.set("mapping_config", JSON.stringify(mappingConfig));
  const res = await handleCreateImport(
    new Request(`${BASE}/api/admin/imports`, {
      method: "POST",
      headers: { cookie: authed(adminUserId).cookie },
      body: form,
    }),
    deps,
  );
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as { importJobId: string; documentId: string };
}

async function runParse(
  deps: AdminImportsDeps,
  adminUserId: string,
  importJobId: string,
): Promise<{
  state: string;
  counts: { total: number; valid: number; invalid: number };
  errors: { rowNumber: number; code: string; message: string }[];
  error?: { code: string; message: string };
}> {
  const res = await handleParseImport(
    new Request(`${BASE}/api/admin/imports/${importJobId}/parse`, {
      method: "POST",
      headers: { cookie: authed(adminUserId).cookie },
    }),
    { params: Promise.resolve({ id: importJobId }) },
    deps,
  );
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json() as Promise<{
    state: string;
    counts: { total: number; valid: number; invalid: number };
    errors: { rowNumber: number; code: string; message: string }[];
    error?: { code: string; message: string };
  }>;
}

async function runCommit(
  deps: AdminImportsDeps,
  adminUserId: string,
  importJobId: string,
): Promise<Response> {
  return handleCommitImport(
    new Request(`${BASE}/api/admin/imports/${importJobId}/commit`, {
      method: "POST",
      headers: { cookie: authed(adminUserId).cookie },
    }),
    { params: Promise.resolve({ id: importJobId }) },
    deps,
  );
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

let s: Seed;

describe("PMB-164 — C8 QA scenarios on representative customer dataset", () => {
  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });
  beforeAll(async () => {
    s = await seed();
  });
  afterEach(async () => {
    await db.$client.exec(`reset role;`);
    await reset();
    s = await seed();
  });

  // -------------------------------------------------------------------------
  // C8.1 — Aircraft master import
  // -------------------------------------------------------------------------

  describe("C8.1 — Aircraft master import", () => {
    it("imports 8 representative aircraft and verifies source_import_row_id FK on every live row", async () => {
      const deps = buildDeps();
      const { importJobId } = await runUpload(
        deps,
        s.adminUserId,
        s.tenantAId,
        AIRCRAFT_CSV,
        "fleet.csv",
        "aircraft",
        AIRCRAFT_MAPPING_CONFIG,
      );

      const parseBody = await runParse(deps, s.adminUserId, importJobId);
      expect(parseBody.state).toBe("ready");
      expect(parseBody.counts).toEqual({ total: 8, valid: 8, invalid: 0 });

      const commitRes = await runCommit(deps, s.adminUserId, importJobId);
      expect(commitRes.status, await commitRes.clone().text()).toBe(200);
      const commitBody = (await commitRes.json()) as {
        state: string;
        rowsCommitted: number;
        alreadyCommitted: boolean;
      };
      expect(commitBody).toMatchObject({
        state: "committed",
        rowsCommitted: 8,
        alreadyCommitted: false,
      });

      // All 8 live rows must carry a non-null source_import_row_id.
      const liveRows = await db.execute<{
        registration: string;
        source_import_row_id: string | null;
      }>(sql`
        select registration, source_import_row_id
          from aircraft
         where tenant_id = ${s.tenantAId}::uuid
         order by registration
      `);
      expect(liveRows.rows).toHaveLength(8);
      expect(liveRows.rows.map((r) => r.registration).sort()).toEqual([
        "N11111",
        "N12345",
        "N22222",
        "N33333",
        "N44444",
        "N54321",
        "N67890",
        "N99999",
      ]);
      for (const row of liveRows.rows) {
        expect(row.source_import_row_id).toBeTruthy();
      }

      // Every staging row must be in 'committed' state with committed_record_id set.
      const stagingRows = await db
        .select()
        .from(importJobRows)
        .where(eq(importJobRows.importJobId, importJobId));
      expect(stagingRows).toHaveLength(8);
      for (const r of stagingRows) {
        expect(r.validationStatus).toBe("committed");
        expect(r.committedRecordId).not.toBeNull();
      }

      // Job header reflects committed state.
      const [job] = await db
        .select()
        .from(importJobs)
        .where(eq(importJobs.id, importJobId));
      expect(job).toMatchObject({
        state: "committed",
        committedByUserId: s.adminUserId,
      });
      expect(job?.committedAt).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // C8.2 — Full maintenance log (5y+)
  // -------------------------------------------------------------------------

  describe("C8.2 — Full maintenance log (5y+)", () => {
    it("imports 18 maintenance records for N77400 spanning 2020-2025 and verifies every row committed", async () => {
      const deps = buildDeps();

      // Aircraft must exist before parse so the aircraft_by_registration
      // lookup in buildTenantCursor can resolve N77400.
      await seedAircraftDirectly(s.tenantAId, s.regimeId, ["N77400"]);

      const { importJobId } = await runUpload(
        deps,
        s.adminUserId,
        s.tenantAId,
        MAINT_CSV,
        "maintenance_log.csv",
        "maintenance_entries",
        MAINT_MAPPING_CONFIG,
      );

      const parseBody = await runParse(deps, s.adminUserId, importJobId);
      expect(parseBody.state, JSON.stringify(parseBody.errors)).toBe("ready");
      expect(parseBody.counts).toMatchObject({ total: 18, valid: 18, invalid: 0 });

      const commitRes = await runCommit(deps, s.adminUserId, importJobId);
      expect(commitRes.status, await commitRes.clone().text()).toBe(200);
      const commitBody = (await commitRes.json()) as {
        state: string;
        rowsCommitted: number;
      };
      expect(commitBody).toMatchObject({ state: "committed", rowsCommitted: 18 });

      // All 18 live maintenance entries must exist with source_import_row_id set.
      const liveEntries = await db.execute<{
        id: string;
        source_import_row_id: string | null;
        entry_type: string;
        performed_on: string;
      }>(sql`
        select id, source_import_row_id, entry_type, performed_on
          from maintenance_entries
         where tenant_id = ${s.tenantAId}::uuid
         order by performed_on
      `);
      expect(liveEntries.rows).toHaveLength(18);

      // Verify a spread of entry types is present.
      const entryTypes = new Set(liveEntries.rows.map((r) => r.entry_type));
      expect(entryTypes).toContain("annual_inspection");
      expect(entryTypes).toContain("maintenance");
      expect(entryTypes).toContain("100_hour_inspection");
      expect(entryTypes).toContain("ad_compliance");

      for (const entry of liveEntries.rows) {
        expect(entry.source_import_row_id).toBeTruthy();
      }

      // Date range sanity — earliest is 2020-09-15, latest is 2024-10-05.
      const dates = liveEntries.rows.map((r) => r.performed_on).sort();
      expect(dates[0]).toMatch(/^2020/);
      expect(dates[dates.length - 1]).toMatch(/^2024/);
    });
  });

  // -------------------------------------------------------------------------
  // C8.3 — Components / life-limited parts
  // -------------------------------------------------------------------------

  describe("C8.3 — Components / life-limited parts", () => {
    it("imports 6 components (engine/propeller/appliance) with correct life-limit fields", async () => {
      const deps = buildDeps();
      const { importJobId } = await runUpload(
        deps,
        s.adminUserId,
        s.tenantAId,
        COMPONENTS_CSV,
        "components.csv",
        "components",
        COMPONENTS_MAPPING_CONFIG,
      );

      const parseBody = await runParse(deps, s.adminUserId, importJobId);
      expect(parseBody.state, JSON.stringify(parseBody.errors)).toBe("ready");
      expect(parseBody.counts).toMatchObject({ total: 6, valid: 6, invalid: 0 });

      const commitRes = await runCommit(deps, s.adminUserId, importJobId);
      expect(commitRes.status, await commitRes.clone().text()).toBe(200);
      const commitBody = (await commitRes.json()) as {
        state: string;
        rowsCommitted: number;
      };
      expect(commitBody).toMatchObject({ state: "committed", rowsCommitted: 6 });

      const liveComponents = await db.execute<{
        kind: string;
        serial_number: string;
        tbo_hours: string | null;
        tbo_calendar_months: number | null;
        cycle_limit: number | null;
        source_import_row_id: string | null;
      }>(sql`
        select kind, serial_number, tbo_hours, tbo_calendar_months, cycle_limit, source_import_row_id
          from components
         where tenant_id = ${s.tenantAId}::uuid
         order by kind, serial_number
      `);
      expect(liveComponents.rows).toHaveLength(6);

      const kinds = liveComponents.rows.map((r) => r.kind);
      expect(kinds.filter((k) => k === "engine")).toHaveLength(2);
      expect(kinds.filter((k) => k === "propeller")).toHaveLength(2);
      expect(kinds.filter((k) => k === "appliance")).toHaveLength(2);

      // Engines have tboHours=2000 (no cycleLimit).
      const engines = liveComponents.rows.filter((r) => r.kind === "engine");
      for (const eng of engines) {
        expect(Number(eng.tbo_hours)).toBe(2000);
        expect(eng.cycle_limit).toBeNull();
        expect(eng.source_import_row_id).toBeTruthy();
      }

      // Propellers have tboHours=2400, tboCalendarMonths=96.
      const props = liveComponents.rows.filter((r) => r.kind === "propeller");
      for (const prop of props) {
        expect(Number(prop.tbo_hours)).toBe(2400);
        expect(prop.tbo_calendar_months).toBe(96);
        expect(prop.source_import_row_id).toBeTruthy();
      }

      // Appliances have no life limits — all null.
      const appl = liveComponents.rows.filter((r) => r.kind === "appliance");
      for (const ap of appl) {
        expect(ap.tbo_hours).toBeNull();
        expect(ap.tbo_calendar_months).toBeNull();
        expect(ap.cycle_limit).toBeNull();
        expect(ap.source_import_row_id).toBeTruthy();
      }
    });
  });

  // -------------------------------------------------------------------------
  // C8.4 — Flight time entries
  // -------------------------------------------------------------------------

  describe("C8.4 — Flight time entries", () => {
    it("imports 12 monotonically-increasing flight time entries for two aircraft", async () => {
      const deps = buildDeps();

      // Aircraft must exist so the aircraft_by_registration lookup resolves.
      await seedAircraftDirectly(s.tenantAId, s.regimeId, ["N55500", "N66600"]);

      const { importJobId } = await runUpload(
        deps,
        s.adminUserId,
        s.tenantAId,
        FLIGHT_TIME_CSV,
        "flight_time.csv",
        "flight_time_entries",
        FLIGHT_TIME_MAPPING_CONFIG,
      );

      const parseBody = await runParse(deps, s.adminUserId, importJobId);
      expect(parseBody.state, JSON.stringify(parseBody.errors)).toBe("ready");
      expect(parseBody.counts).toMatchObject({ total: 12, valid: 12, invalid: 0 });

      const commitRes = await runCommit(deps, s.adminUserId, importJobId);
      expect(commitRes.status, await commitRes.clone().text()).toBe(200);
      const commitBody = (await commitRes.json()) as { rowsCommitted: number };
      expect(commitBody.rowsCommitted).toBe(12);

      const liveFte = await db.execute<{
        airframe_time_new: string;
        source_import_row_id: string | null;
      }>(sql`
        select ft.airframe_time_new, ft.source_import_row_id
          from flight_time_entries ft
          join aircraft a on a.id = ft.aircraft_id
         where ft.tenant_id = ${s.tenantAId}::uuid
         order by a.registration, ft.airframe_time_new::numeric
      `);
      expect(liveFte.rows).toHaveLength(12);
      for (const row of liveFte.rows) {
        expect(row.source_import_row_id).toBeTruthy();
      }

      // N55500 entries: 100, 150.5, 200, 250.3, 300.8, 350 (strictly increasing).
      const n55 = liveFte.rows.slice(0, 6).map((r) => Number(r.airframe_time_new));
      for (let i = 1; i < n55.length; i++) {
        expect(n55[i]).toBeGreaterThan(n55[i - 1]!);
      }
    });
  });

  // -------------------------------------------------------------------------
  // C8.5 — Malformed rows (commit gate)
  // -------------------------------------------------------------------------

  describe("C8.5 — Malformed rows must block commit", () => {
    it("parse returns ready with invalid rows; commit returns 422 and writes no live rows", async () => {
      const deps = buildDeps();
      const { importJobId } = await runUpload(
        deps,
        s.adminUserId,
        s.tenantAId,
        MALFORMED_AIRCRAFT_CSV,
        "bad_fleet.csv",
        "aircraft",
        AIRCRAFT_MAPPING_CONFIG,
      );

      const parseBody = await runParse(deps, s.adminUserId, importJobId);
      expect(parseBody.state).toBe("ready");
      // 4 rows total, 2 invalid (ZZBAD registration + negative hours)
      expect(parseBody.counts.total).toBe(4);
      expect(parseBody.counts.invalid).toBe(2);
      expect(parseBody.counts.valid).toBe(2);

      // Verify one of the errors names the invalid registration.
      const regErr = parseBody.errors.find((e) =>
        e.code === "INVALID_REGISTRATION",
      );
      expect(regErr).toBeDefined();

      // Commit must be rejected as a precondition failure (not a server
      // error). The pipeline re-throws ImportJobHasInvalidRowsError
      // directly — bypassing the failure-recording path — so the HTTP
      // response is 422 with code IMPORT_JOB_HAS_INVALID_ROWS, no live
      // rows are written, and the job stays in 'ready' so the operator
      // can fix the bad rows and retry. (PMB-201)
      const commitRes = await runCommit(deps, s.adminUserId, importJobId);
      expect(commitRes.status, await commitRes.clone().text()).toBe(422);
      const commitErr = (await commitRes.json()) as { code: string };
      expect(commitErr.code).toBe("IMPORT_JOB_HAS_INVALID_ROWS");

      // No live rows must have been written for this job.
      const liveCount = await db.execute<{ count: string }>(sql`
        select count(*)::text as count
          from aircraft
         where tenant_id = ${s.tenantAId}::uuid
      `);
      expect(Number(liveCount.rows[0]!.count)).toBe(0);

      // Job stays in 'ready' (not 'failed'); error_summary is not
      // overwritten by the gate-rejected commit attempt.
      const [jobAfterRejectedCommit] = await db
        .select()
        .from(importJobs)
        .where(eq(importJobs.id, importJobId));
      expect(jobAfterRejectedCommit?.state).toBe("ready");
      expect(jobAfterRejectedCommit?.errorSummary).toBeNull();
    });

    it("GET status after rejected commit still shows 'ready' (retryable after row fixes)", async () => {
      const deps = buildDeps();
      const { importJobId } = await runUpload(
        deps,
        s.adminUserId,
        s.tenantAId,
        MALFORMED_AIRCRAFT_CSV,
        "bad_fleet.csv",
        "aircraft",
        AIRCRAFT_MAPPING_CONFIG,
      );
      await runParse(deps, s.adminUserId, importJobId);
      await runCommit(deps, s.adminUserId, importJobId); // returns 422

      const statusRes = await handleGetImport(
        new Request(`${BASE}/api/admin/imports/${importJobId}`, {
          method: "GET",
          headers: { cookie: authed(s.adminUserId).cookie },
        }),
        { params: Promise.resolve({ id: importJobId }) },
        deps,
      );
      expect(statusRes.status).toBe(200);
      const body = (await statusRes.json()) as {
        state: string;
        errorSummary?: { code: string };
      };
      // The pipeline re-throws ImportJobHasInvalidRowsError directly,
      // so the gate rejection leaves the job in 'ready' — the operator
      // can re-parse with corrected data and retry the commit.
      expect(body.state).toBe("ready");
    });
  });

  // -------------------------------------------------------------------------
  // C8.6 — Idempotent retry
  // -------------------------------------------------------------------------

  describe("C8.6 — Idempotent retry", () => {
    it("second commit on the same committed job returns alreadyCommitted:true with unchanged row count", async () => {
      const deps = buildDeps();
      const { importJobId } = await runUpload(
        deps,
        s.adminUserId,
        s.tenantAId,
        COMPONENTS_CSV,
        "components.csv",
        "components",
        COMPONENTS_MAPPING_CONFIG,
      );
      await runParse(deps, s.adminUserId, importJobId);

      // First commit.
      const firstRes = await runCommit(deps, s.adminUserId, importJobId);
      expect(firstRes.status).toBe(200);
      const first = (await firstRes.json()) as {
        rowsCommitted: number;
        alreadyCommitted: boolean;
      };
      expect(first.alreadyCommitted).toBe(false);
      expect(first.rowsCommitted).toBe(6);

      // Second commit — idempotent no-op.
      const secondRes = await runCommit(deps, s.adminUserId, importJobId);
      expect(secondRes.status).toBe(200);
      const second = (await secondRes.json()) as {
        rowsCommitted: number;
        alreadyCommitted: boolean;
      };
      expect(second.alreadyCommitted).toBe(true);
      expect(second.rowsCommitted).toBe(6);

      // Exactly 6 components in the live table — no duplicates.
      const liveCount = await db.execute<{ count: string }>(sql`
        select count(*)::text as count
          from components
         where tenant_id = ${s.tenantAId}::uuid
      `);
      expect(Number(liveCount.rows[0]!.count)).toBe(6);
    });
  });

  // -------------------------------------------------------------------------
  // C8.7 — Row-level traceability chain
  // -------------------------------------------------------------------------

  describe("C8.7 — Row-level traceability chain", () => {
    it("walks maintenance_entry.source_import_row_id → import_job_rows → import_jobs → documents.object_key", async () => {
      const deps = buildDeps();
      await seedAircraftDirectly(s.tenantAId, s.regimeId, ["N77400"]);

      const { importJobId } = await runUpload(
        deps,
        s.adminUserId,
        s.tenantAId,
        MAINT_CSV,
        "maintenance_log.csv",
        "maintenance_entries",
        MAINT_MAPPING_CONFIG,
      );
      await runParse(deps, s.adminUserId, importJobId);
      const commitRes = await runCommit(deps, s.adminUserId, importJobId);
      expect(commitRes.status).toBe(200);

      // 1. Pick one committed maintenance entry.
      const entryResult = await db.execute<{
        id: string;
        source_import_row_id: string;
      }>(sql`
        select id, source_import_row_id
          from maintenance_entries
         where tenant_id = ${s.tenantAId}::uuid
           and source_import_row_id is not null
         limit 1
      `);
      expect(entryResult.rows).toHaveLength(1);
      const sourceImportRowId = entryResult.rows[0]!.source_import_row_id;
      const entryId = entryResult.rows[0]!.id;
      expect(sourceImportRowId).toBeTruthy();

      // 2. Follow source_import_row_id → import_job_rows.
      const stagingResult = await db.execute<{
        id: string;
        import_job_id: string;
        validation_status: string;
        committed_record_id: string | null;
      }>(sql`
        select id, import_job_id, validation_status, committed_record_id
          from import_job_rows
         where id = ${sourceImportRowId}::uuid
      `);
      expect(stagingResult.rows).toHaveLength(1);
      expect(stagingResult.rows[0]!.validation_status).toBe("committed");
      // committed_record_id points back at the live maintenance entry.
      expect(stagingResult.rows[0]!.committed_record_id).toBe(entryId);
      const importJobIdFromRow = stagingResult.rows[0]!.import_job_id;

      // 3. Follow import_job_id → import_jobs.source_document_id.
      const jobResult = await db.execute<{
        id: string;
        source_document_id: string;
        state: string;
      }>(sql`
        select id, source_document_id, state
          from import_jobs
         where id = ${importJobIdFromRow}::uuid
      `);
      expect(jobResult.rows).toHaveLength(1);
      expect(jobResult.rows[0]!.state).toBe("committed");
      const sourceDocumentId = jobResult.rows[0]!.source_document_id;
      expect(sourceDocumentId).toBeTruthy();

      // 4. Follow source_document_id → documents.object_key.
      const docResult = await db.execute<{
        id: string;
        object_key: string;
        document_type: string;
        original_filename: string;
      }>(sql`
        select id, object_key, document_type, original_filename
          from documents
         where id = ${sourceDocumentId}::uuid
      `);
      expect(docResult.rows).toHaveLength(1);
      expect(docResult.rows[0]!.document_type).toBe("import_source");
      expect(docResult.rows[0]!.original_filename).toBe("maintenance_log.csv");
      // object_key is the storage key — must be non-null and non-empty.
      expect(docResult.rows[0]!.object_key).toBeTruthy();

      // Traceability chain is intact.
    });
  });

  // -------------------------------------------------------------------------
  // C8.8 — RLS tenant isolation
  // -------------------------------------------------------------------------

  describe("C8.8 — RLS tenant isolation", () => {
    it("tenant_app under tenant B cannot see import_jobs belonging to tenant A", async () => {
      const deps = buildDeps();

      // Create a committed import for tenant A.
      const { importJobId } = await runUpload(
        deps,
        s.adminUserId,
        s.tenantAId,
        AIRCRAFT_CSV,
        "fleet.csv",
        "aircraft",
        AIRCRAFT_MAPPING_CONFIG,
      );
      await runParse(deps, s.adminUserId, importJobId);
      await runCommit(deps, s.adminUserId, importJobId);

      // Confirm the job exists as owner (no RLS).
      const ownerCheck = await db.execute<{ count: string }>(sql`
        select count(*)::text as count from import_jobs
         where tenant_id = ${s.tenantAId}::uuid
      `);
      expect(Number(ownerCheck.rows[0]!.count)).toBeGreaterThan(0);

      // Switch to tenant_app role under tenant B's context.
      await db.$client.exec(
        `select set_config('app.current_tenant_id', '${s.tenantBId}', false);`,
      );
      await db.$client.exec(`set role ${TENANT_APP_ROLE};`);

      // Tenant B's session should see zero import_jobs.
      const tenantBJobs = await db.execute<{ count: string }>(
        sql`select count(*)::text as count from import_jobs`,
      );
      expect(Number(tenantBJobs.rows[0]!.count)).toBe(0);

      await db.$client.exec(`reset role;`);
    });

    it("tenant_app under tenant B cannot see import_job_rows belonging to tenant A", async () => {
      const deps = buildDeps();

      const { importJobId } = await runUpload(
        deps,
        s.adminUserId,
        s.tenantAId,
        AIRCRAFT_CSV,
        "fleet.csv",
        "aircraft",
        AIRCRAFT_MAPPING_CONFIG,
      );
      await runParse(deps, s.adminUserId, importJobId);
      await runCommit(deps, s.adminUserId, importJobId);

      // Confirm staging rows exist as owner.
      const ownerCheck = await db.execute<{ count: string }>(sql`
        select count(*)::text as count from import_job_rows
         where tenant_id = ${s.tenantAId}::uuid
      `);
      expect(Number(ownerCheck.rows[0]!.count)).toBeGreaterThan(0);

      // Switch to tenant B.
      await db.$client.exec(
        `select set_config('app.current_tenant_id', '${s.tenantBId}', false);`,
      );
      await db.$client.exec(`set role ${TENANT_APP_ROLE};`);

      const tenantBRows = await db.execute<{ count: string }>(
        sql`select count(*)::text as count from import_job_rows`,
      );
      expect(Number(tenantBRows.rows[0]!.count)).toBe(0);

      await db.$client.exec(`reset role;`);
    });
  });
});
