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
 * PMB-162 / C6 — End-to-end happy path for the admin importer routes.
 *
 * Drives a representative CSV through the four routes:
 *
 *   1. POST /api/admin/imports            (multipart upload)
 *   2. POST /api/admin/imports/:id/parse  (parser+mapper+validator)
 *   3. GET  /api/admin/imports/:id        (status + paginated errors)
 *   4. POST /api/admin/imports/:id/commit (single-tx commit)
 *
 * Verifies the documents row, import_jobs row, per-row staging records,
 * and the live aircraft rows that the commit pipeline materializes.
 */

const {
  aircraft,
  documents,
  importJobs,
  importJobRows,
  organizationMemberships,
  organizations,
  platformAdmins,
  regimes,
  users,
} = dbSchema;

const SECRET =
  "test-only-secret-test-only-secret-test-only-secret-32+bytes";

let db: TestDb;
let reset: () => Promise<void>;

interface Seed {
  adminUserId: string;
  tenantId: string;
  regimeId: string;
  password: string;
}

async function seed(): Promise<Seed> {
  const hash = await passwordHasher.hash("correct horse battery staple");
  const [admin] = await db
    .insert(users)
    .values([{ email: "admin@platform.test", passwordHash: hash }])
    .returning();
  if (!admin) throw new Error("seed users failed");

  await db
    .insert(platformAdmins)
    .values({ userId: admin.id, note: "test seed" });

  const [faa] = await db.select().from(regimes);
  if (!faa) throw new Error("FAA regime seed missing");

  const [tenantOrg] = await db
    .insert(organizations)
    .values({
      name: "Tenant Org",
      orgType: "club",
      defaultRegimeId: faa.id,
    })
    .returning();
  if (!tenantOrg) throw new Error("seed org failed");

  await db.insert(organizationMemberships).values({
    tenantId: tenantOrg.id,
    userId: admin.id,
    role: "admin",
  });

  return {
    adminUserId: admin.id,
    tenantId: tenantOrg.id,
    regimeId: faa.id,
    password: "correct horse battery staple",
  };
}

function buildDeps(): AdminImportsDeps {
  // pglite: db and directDb point at the same handle (no BYPASSRLS
  // distinction in-memory). Production wires separate handles.
  const documentsService = new DocumentsService(db, new MemoryBlobDriver(), "memory");
  return {
    db,
    directDb: db,
    documentsService,
    secret: SECRET,
  };
}

function authed(userId: string): { cookie: string } {
  const cookie = createSessionCookieValue(
    { userId, iat: Math.floor(Date.now() / 1000) },
    SECRET,
  );
  return { cookie: `${SESSION_COOKIE_NAME}=${cookie}` };
}

const BASE = "https://app.example.test";

/**
 * 4-row CSV that exercises the aircraft validator end-to-end. The
 * registration column maps to the live aircraft table; everything else
 * uses simple column or constant mappings.
 */
const FIXTURE_CSV = `Tail,Make,Model,Serial,Hours
N12345,Cessna,172,SN-100,1234.5
N67890,Piper,PA28,SN-101,789.0
N54321,Cirrus,SR22,SN-102,200.3
N99999,Beechcraft,Bonanza,SN-103,3500.0
`;

const FIXTURE_MAPPING_CONFIG = {
  version: "1",
  targetTable: "aircraft",
  columns: {
    registration: { source: "Tail" },
    make: { source: "Make" },
    model: { source: "Model" },
    serialNumber: { source: "Serial" },
    airframeTotalTime: { source: "Hours", format: { kind: "decimal" } },
  },
  constants: {
    category: "standard",
    aircraftClass: "airplane",
    timeSource: "hobbs",
  },
  lookups: [
    {
      kind: "regime_by_code",
      target: "regimeId",
      value: "FAA",
    },
  ],
} as const;

describe("PMB-162 admin importer routes — end-to-end happy path", () => {
  let s: Seed;
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

  async function uploadFixture(deps: AdminImportsDeps): Promise<{
    importJobId: string;
    documentId: string;
  }> {
    const form = new FormData();
    form.set(
      "file",
      new File([FIXTURE_CSV], "fleet.csv", { type: "text/csv" }),
    );
    form.set("tenant_id", s.tenantId);
    form.set("target_table", "aircraft");
    form.set("mapping_config", JSON.stringify(FIXTURE_MAPPING_CONFIG));

    const req = new Request(`${BASE}/api/admin/imports`, {
      method: "POST",
      headers: { cookie: authed(s.adminUserId).cookie },
      body: form,
    });
    const res = await handleCreateImport(req, deps);
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as {
      importJobId: string;
      documentId: string;
    };
  }

  it("uploads, parses, status, commits — and writes the live aircraft rows", async () => {
    const deps = buildDeps();

    // 1. Upload
    const { importJobId, documentId } = await uploadFixture(deps);
    expect(importJobId).toMatch(
      /^[0-9a-f-]{36}$/,
    );

    const [doc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId));
    expect(doc?.documentType).toBe("import_source");
    expect(doc?.tenantId).toBe(s.tenantId);

    const [jobAfterUpload] = await db
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, importJobId));
    expect(jobAfterUpload).toMatchObject({
      state: "pending",
      tenantId: s.tenantId,
      regimeId: s.regimeId,
      targetTable: "aircraft",
      sourceDocumentId: documentId,
    });
    expect(jobAfterUpload?.mappingConfig).toMatchObject({ version: "1" });

    // 2. Parse
    const parseReq = new Request(
      `${BASE}/api/admin/imports/${importJobId}/parse`,
      {
        method: "POST",
        headers: { cookie: authed(s.adminUserId).cookie },
      },
    );
    const parseRes = await handleParseImport(
      parseReq,
      { params: Promise.resolve({ id: importJobId }) },
      deps,
    );
    expect(parseRes.status, await parseRes.clone().text()).toBe(200);
    const parseBody = (await parseRes.json()) as {
      state: string;
      counts: { total: number; valid: number; invalid: number };
    };
    expect(parseBody.state).toBe("ready");
    expect(parseBody.counts).toEqual({ total: 4, valid: 4, invalid: 0 });

    const stagedRows = await db
      .select()
      .from(importJobRows)
      .where(eq(importJobRows.importJobId, importJobId));
    expect(stagedRows).toHaveLength(4);
    for (const row of stagedRows) {
      expect(row.validationStatus).toBe("valid");
      expect(row.targetTable).toBe("aircraft");
      expect(row.mappedPayload).toMatchObject({
        category: "standard",
        aircraftClass: "airplane",
        timeSource: "hobbs",
      });
    }

    // 3. Status
    const statusReq = new Request(
      `${BASE}/api/admin/imports/${importJobId}`,
      {
        method: "GET",
        headers: { cookie: authed(s.adminUserId).cookie },
      },
    );
    const statusRes = await handleGetImport(
      statusReq,
      { params: Promise.resolve({ id: importJobId }) },
      deps,
    );
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as {
      state: string;
      counts: { total: number; valid: number; invalid: number; committed: number };
      errors: unknown[];
    };
    expect(statusBody.state).toBe("ready");
    expect(statusBody.counts).toEqual({
      total: 4,
      valid: 4,
      invalid: 0,
      committed: 0,
    });
    expect(statusBody.errors).toEqual([]);

    // 4. Commit
    const commitReq = new Request(
      `${BASE}/api/admin/imports/${importJobId}/commit`,
      {
        method: "POST",
        headers: { cookie: authed(s.adminUserId).cookie },
      },
    );
    const commitRes = await handleCommitImport(
      commitReq,
      { params: Promise.resolve({ id: importJobId }) },
      deps,
    );
    expect(commitRes.status, await commitRes.clone().text()).toBe(200);
    const commitBody = (await commitRes.json()) as {
      state: string;
      rowsCommitted: number;
      alreadyCommitted: boolean;
    };
    expect(commitBody).toMatchObject({
      state: "committed",
      rowsCommitted: 4,
      alreadyCommitted: false,
    });

    // Verify live aircraft rows landed with the traceability FK.
    const liveAircraft = await db.execute<{
      registration: string;
      source_import_row_id: string | null;
    }>(sql`
      select registration, source_import_row_id
        from aircraft
       where tenant_id = ${s.tenantId}::uuid
       order by registration
    `);
    expect(liveAircraft.rows).toHaveLength(4);
    expect(liveAircraft.rows.map((r) => r.registration).sort()).toEqual([
      "N12345",
      "N54321",
      "N67890",
      "N99999",
    ]);
    for (const live of liveAircraft.rows) {
      expect(live.source_import_row_id).toBeTruthy();
    }

    // Verify staging rows flipped to 'committed' with committed_record_id.
    const committedRows = await db
      .select()
      .from(importJobRows)
      .where(eq(importJobRows.importJobId, importJobId));
    for (const row of committedRows) {
      expect(row.validationStatus).toBe("committed");
      expect(row.committedRecordId).not.toBeNull();
    }

    // Verify job header flip.
    const [finalJob] = await db
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, importJobId));
    expect(finalJob).toMatchObject({
      state: "committed",
      committedByUserId: s.adminUserId,
    });
    expect(finalJob?.committedAt).not.toBeNull();

    // 5. Commit again — idempotent no-op.
    const replayRes = await handleCommitImport(
      new Request(`${BASE}/api/admin/imports/${importJobId}/commit`, {
        method: "POST",
        headers: { cookie: authed(s.adminUserId).cookie },
      }),
      { params: Promise.resolve({ id: importJobId }) },
      deps,
    );
    expect(replayRes.status).toBe(200);
    const replayBody = (await replayRes.json()) as {
      alreadyCommitted: boolean;
      rowsCommitted: number;
    };
    expect(replayBody).toMatchObject({
      alreadyCommitted: true,
      rowsCommitted: 4,
    });
  });

  it("rejects unauthenticated requests with 401", async () => {
    const deps = buildDeps();
    const form = new FormData();
    form.set(
      "file",
      new File([FIXTURE_CSV], "fleet.csv", { type: "text/csv" }),
    );
    form.set("tenant_id", s.tenantId);
    form.set("target_table", "aircraft");
    form.set("mapping_config", JSON.stringify(FIXTURE_MAPPING_CONFIG));

    const res = await handleCreateImport(
      new Request(`${BASE}/api/admin/imports`, {
        method: "POST",
        body: form,
      }),
      deps,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a non-platform-admin user with 403", async () => {
    const deps = buildDeps();
    // Create a user that is NOT a platform admin.
    const hash = await passwordHasher.hash("correct horse battery staple");
    const [outsider] = await db
      .insert(users)
      .values([{ email: "outsider@example.test", passwordHash: hash }])
      .returning();

    const form = new FormData();
    form.set(
      "file",
      new File([FIXTURE_CSV], "fleet.csv", { type: "text/csv" }),
    );
    form.set("tenant_id", s.tenantId);
    form.set("target_table", "aircraft");
    form.set("mapping_config", JSON.stringify(FIXTURE_MAPPING_CONFIG));

    const res = await handleCreateImport(
      new Request(`${BASE}/api/admin/imports`, {
        method: "POST",
        headers: { cookie: authed(outsider!.id).cookie },
        body: form,
      }),
      deps,
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when mapping_config.targetTable disagrees with the form", async () => {
    const deps = buildDeps();
    const form = new FormData();
    form.set(
      "file",
      new File([FIXTURE_CSV], "fleet.csv", { type: "text/csv" }),
    );
    form.set("tenant_id", s.tenantId);
    form.set("target_table", "aircraft");
    form.set(
      "mapping_config",
      JSON.stringify({ ...FIXTURE_MAPPING_CONFIG, targetTable: "components" }),
    );

    const res = await handleCreateImport(
      new Request(`${BASE}/api/admin/imports`, {
        method: "POST",
        headers: { cookie: authed(s.adminUserId).cookie },
        body: form,
      }),
      deps,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation_error");
  });

  it("flips state to 'failed' when the mapping_config refers to an unknown source column", async () => {
    const deps = buildDeps();
    const { importJobId } = await uploadFixture(deps);

    // Patch the persisted mapping_config to point at a missing column.
    const brokenConfig = JSON.parse(JSON.stringify(FIXTURE_MAPPING_CONFIG)) as {
      columns: Record<string, { source: string }>;
    };
    brokenConfig.columns.make = { source: "Manufacturer_Not_Present" };
    await db
      .update(importJobs)
      .set({ mappingConfig: brokenConfig })
      .where(eq(importJobs.id, importJobId));

    const res = await handleParseImport(
      new Request(`${BASE}/api/admin/imports/${importJobId}/parse`, {
        method: "POST",
        headers: { cookie: authed(s.adminUserId).cookie },
      }),
      { params: Promise.resolve({ id: importJobId }) },
      deps,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; error: { code: string } };
    expect(body.state).toBe("failed");
    expect(body.error.code).toBe("MAPPING_CONFIG_INVALID");

    const [job] = await db
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, importJobId));
    expect(job?.state).toBe("failed");
  });

  it("commit refuses a non-ready job with 409", async () => {
    const deps = buildDeps();
    const { importJobId } = await uploadFixture(deps);
    const res = await handleCommitImport(
      new Request(`${BASE}/api/admin/imports/${importJobId}/commit`, {
        method: "POST",
        headers: { cookie: authed(s.adminUserId).cookie },
      }),
      { params: Promise.resolve({ id: importJobId }) },
      deps,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("IMPORT_JOB_NOT_COMMITABLE");
  });
});
