import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestSuite, type TestDb } from "@ga/db";

import {
  TENANT_APP_ROLE,
  TENANT_CONTEXT_GUC,
  clearTenantContext,
  runAsTenant,
  setTenantContext,
} from "../src/test/tenant.js";

/**
 * A1.2 (PMB-31) — verify that migration 0004 actually isolates tenants at
 * the database level for `organization_memberships`, `invitations`, and
 * `email_outbox`, plus `documents` (J2.1's deferred policy).
 *
 * RLS in Postgres has two well-known footguns this test catches:
 *   * Superusers bypass RLS regardless of FORCE ROW LEVEL SECURITY, so
 *     "the tests pass" means nothing unless we actually SET ROLE to
 *     `tenant_app` first. The "superuser sees everything" test below
 *     proves the test harness is exercising the policy and not just
 *     hiding behind the superuser bypass.
 *   * `current_setting('app.current_tenant_id', true)` returns NULL when
 *     the GUC is unset, and NULL never equals anything in SQL — so the
 *     policy fails closed. The "cleared context" test pins that.
 */

type TenantSeed = {
  orgId: string;
  userId: string;
};

/**
 * Seed two tenant orgs, each with one membership, one invitation, and one
 * outbox row. Done as superuser before any role-switch so the tests have
 * a known starting state regardless of RLS.
 */
async function seedTwoTenants(db: TestDb): Promise<{
  a: TenantSeed;
  b: TenantSeed;
}> {
  const regime = await db.execute<{ id: string }>(
    sql`select id from regimes where code = 'FAA'`,
  );
  const regimeId = regime.rows[0]!.id;

  const orgs = await db.execute<{ id: string; name: string }>(sql`
    insert into organizations (name, org_type, default_regime_id)
    values ('Tenant A', 'school', ${regimeId}),
           ('Tenant B', 'shop',   ${regimeId})
    returning id, name
  `);
  const orgA = orgs.rows.find((r) => r.name === "Tenant A")!.id;
  const orgB = orgs.rows.find((r) => r.name === "Tenant B")!.id;

  const usersResult = await db.execute<{ id: string; email: string }>(sql`
    insert into users (email) values
      ('a@example.test'),
      ('b@example.test')
    returning id, email
  `);
  const userA = usersResult.rows.find((r) => r.email === "a@example.test")!.id;
  const userB = usersResult.rows.find((r) => r.email === "b@example.test")!.id;

  // Per-tenant data: 1 membership, 1 invitation, 1 outbox row.
  await db.execute(sql`
    insert into organization_memberships (tenant_id, user_id, role) values
      (${orgA}, ${userA}, 'admin'),
      (${orgB}, ${userB}, 'admin')
  `);
  await db.execute(sql`
    insert into invitations
      (tenant_id, email, role, invited_by_user_id, token_hash, expires_at)
    values
      (${orgA}, 'invitee-a@example.test', 'pilot', ${userA}, 'hash-a', now() + interval '7 days'),
      (${orgB}, 'invitee-b@example.test', 'pilot', ${userB}, 'hash-b', now() + interval '7 days')
  `);
  await db.execute(sql`
    insert into email_outbox (tenant_id, recipient_email, subject, body_text) values
      (${orgA}, 'a@example.test', 'A-subject', 'A-body'),
      (${orgB}, 'b@example.test', 'B-subject', 'B-body')
  `);

  return { a: { orgId: orgA, userId: userA }, b: { orgId: orgB, userId: userB } };
}

type Executor = {
  execute: TestDb["execute"];
};

async function countAs(
  exec: Executor,
  table: "organization_memberships" | "invitations" | "email_outbox" | "documents",
): Promise<number> {
  const result = await exec.execute<{ count: string }>(
    sql.raw(`select count(*)::text as count from ${table}`),
  );
  return Number(result.rows[0]!.count);
}

describe("A1.2 tenant RLS — accounts tables (PMB-31)", () => {
  let db: TestDb;
  let reset: () => Promise<void>;

  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });

  afterEach(async () => {
    await reset();
  });

  it("scopes reads to the active tenant under tenant_app role", async () => {
    const { a, b } = await seedTwoTenants(db);

    await runAsTenant(db, a.orgId, async (tx) => {
      expect(await countAs(tx, "organization_memberships")).toBe(1);
      expect(await countAs(tx, "invitations")).toBe(1);
      expect(await countAs(tx, "email_outbox")).toBe(1);

      const labels = await tx.execute<{ email: string }>(
        sql`select email from invitations`,
      );
      expect(labels.rows.map((r) => r.email)).toEqual([
        "invitee-a@example.test",
      ]);
    });

    await runAsTenant(db, b.orgId, async (tx) => {
      const labels = await tx.execute<{ email: string }>(
        sql`select email from invitations`,
      );
      expect(labels.rows.map((r) => r.email)).toEqual([
        "invitee-b@example.test",
      ]);
    });
  });

  it("blocks cross-tenant writes via WITH CHECK", async () => {
    const { a, b } = await seedTwoTenants(db);

    // Tenant A tries to insert an invitation for Tenant B.
    await expect(
      runAsTenant(db, a.orgId, async (tx) => {
        await tx.execute(sql`
          insert into invitations
            (tenant_id, email, role, invited_by_user_id, token_hash, expires_at)
          values
            (${b.orgId}, 'sneaky@example.test', 'admin', ${a.userId},
             'hash-sneaky', now() + interval '7 days')
        `);
      }),
    ).rejects.toThrow(/row-level security|policy/i);

    // Tenant A tries to update Tenant B's existing invitation row — should
    // see zero matching rows under RLS, so the update returns 0 rows.
    await runAsTenant(db, a.orgId, async (tx) => {
      const updated = await tx.execute<{ id: string }>(sql`
        update invitations
           set email = 'tampered@example.test'
         where tenant_id = ${b.orgId}
      returning id
      `);
      expect(updated.rows).toEqual([]);
    });

    // And Tenant B's data is intact.
    await runAsTenant(db, b.orgId, async (tx) => {
      const labels = await tx.execute<{ email: string }>(
        sql`select email from invitations`,
      );
      expect(labels.rows.map((r) => r.email)).toEqual([
        "invitee-b@example.test",
      ]);
    });
  });

  it("returns zero rows when no tenant context is set under tenant_app", async () => {
    await seedTwoTenants(db);

    // Switch to tenant_app at the session level, but leave the GUC unset
    // — RLS must fail closed.
    await db.$client.exec(`set role ${TENANT_APP_ROLE};`);
    await clearTenantContext(db);

    expect(await countAs(db, "organization_memberships")).toBe(0);
    expect(await countAs(db, "invitations")).toBe(0);
    expect(await countAs(db, "email_outbox")).toBe(0);
    expect(await countAs(db, "documents")).toBe(0);

    await db.$client.exec("reset role;");
  });

  it("(negative control) a superuser without SET ROLE sees every tenant's rows", async () => {
    // Confirms the previous test actually exercises the policy rather than
    // hiding behind the superuser bypass. If this fails, the seed is wrong
    // (no data); if the gated tests pass and this also restricts visibility,
    // the policy isn't being exercised at all.
    await seedTwoTenants(db);

    expect(await countAs(db, "organization_memberships")).toBe(2);
    expect(await countAs(db, "invitations")).toBe(2);
    expect(await countAs(db, "email_outbox")).toBe(2);
  });

  it("isolates documents via runAsTenant (J2.1 deferred-policy gap closed)", async () => {
    const { a, b } = await seedTwoTenants(db);

    // Seed one document per tenant. object_key has the CHECK constraint
    // `tenants/{tenant_id}/...` from migration 0003 — keep that prefix.
    await db.execute(sql`
      insert into documents
        (tenant_id, document_type, object_key, storage_url,
         original_filename, content_type, byte_size, sha256_hex)
      values
        (${a.orgId}, 'logbook',
         ${`tenants/${a.orgId}/logbook/a/sample.pdf`},
         'https://example.test/a.pdf', 'a.pdf', 'application/pdf', 1, 'a'),
        (${b.orgId}, 'logbook',
         ${`tenants/${b.orgId}/logbook/b/sample.pdf`},
         'https://example.test/b.pdf', 'b.pdf', 'application/pdf', 1, 'b')
    `);

    await runAsTenant(db, a.orgId, async (tx) => {
      const result = await tx.execute<{ original_filename: string }>(
        sql`select original_filename from documents`,
      );
      expect(result.rows.map((r) => r.original_filename)).toEqual(["a.pdf"]);
    });

    await runAsTenant(db, b.orgId, async (tx) => {
      const result = await tx.execute<{ original_filename: string }>(
        sql`select original_filename from documents`,
      );
      expect(result.rows.map((r) => r.original_filename)).toEqual(["b.pdf"]);
    });
  });

  it("LOCAL settings inside runAsTenant do not leak after the transaction", async () => {
    const { a } = await seedTwoTenants(db);

    await runAsTenant(db, a.orgId, async (tx) => {
      const inside = await tx.execute<{ role: string; tenant: string | null }>(
        sql`select current_user as role,
                   current_setting(${TENANT_CONTEXT_GUC}, true) as tenant`,
      );
      expect(inside.rows[0]?.role).toBe(TENANT_APP_ROLE);
      expect(inside.rows[0]?.tenant).toBe(a.orgId);
    });

    // After the transaction, the connection is back to superuser and the
    // GUC is unset.
    const after = await db.execute<{ role: string; tenant: string | null }>(
      sql`select current_user as role,
                 current_setting(${TENANT_CONTEXT_GUC}, true) as tenant`,
    );
    expect(after.rows[0]?.role).not.toBe(TENANT_APP_ROLE);
    expect(after.rows[0]?.tenant ?? "").toBe("");
  });

  it("rolls back LOCAL settings on a thrown error", async () => {
    const { a } = await seedTwoTenants(db);

    await expect(
      runAsTenant(db, a.orgId, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const after = await db.execute<{ role: string; tenant: string | null }>(
      sql`select current_user as role,
                 current_setting(${TENANT_CONTEXT_GUC}, true) as tenant`,
    );
    expect(after.rows[0]?.role).not.toBe(TENANT_APP_ROLE);
    expect(after.rows[0]?.tenant ?? "").toBe("");
  });

  it("setTenantContext + SET ROLE still works for ad-hoc test setup", async () => {
    // Sanity check: the lower-level session-scoped helpers continue to
    // work alongside runAsTenant. Other packages may pre-date the
    // transaction-wrapping helper.
    const { b } = await seedTwoTenants(db);

    await db.$client.exec(`set role ${TENANT_APP_ROLE};`);
    await setTenantContext(db, b.orgId);

    const rows = await db.execute<{ subject: string }>(
      sql`select subject from email_outbox`,
    );
    expect(rows.rows.map((r) => r.subject)).toEqual(["B-subject"]);

    await clearTenantContext(db);
    await db.$client.exec("reset role;");
  });
});
