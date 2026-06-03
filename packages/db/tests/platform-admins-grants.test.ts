import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestSuite, type TestDb } from "@ga/db";

import { TENANT_APP_ROLE } from "../src/test/tenant.js";

/**
 * PMB-116 — `platform_admins` is global identity, NOT tenant-scoped. The
 * grants posture is what makes "a tenant tx must never see platform-admin
 * status" a database property rather than a coding convention.
 *
 * This suite locks in the three properties the C1 acceptance criteria call
 * out:
 *
 *   1. `tenant_app` has NO privilege on `platform_admins` — neither SELECT
 *      nor any write. A tenant tx (`set local role tenant_app`) hitting the
 *      table errors with `permission denied for table platform_admins`.
 *   2. `tenant_runtime` has SELECT — the bare connection (auth path) can
 *      read the gate.
 *   3. The bootstrap DO block in migration 0023 is idempotent: the same
 *      `app.platform_admin_bootstrap_email` re-applied does NOT produce a
 *      second row, and an unset GUC is a no-op.
 */

const ADMIN_USER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ADMIN_EMAIL = "admin@example.test";

async function seedAdminUser(db: TestDb): Promise<void> {
  await db.execute(sql`
    insert into users (id, email) values (${ADMIN_USER}, ${ADMIN_EMAIL})
    on conflict do nothing
  `);
}

describe("PMB-116 platform_admins grants posture", () => {
  let db: TestDb;
  let reset: () => Promise<void>;

  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });

  afterEach(async () => {
    await db.$client.exec(`reset role;`);
    await reset();
  });

  it("tenant_app has NO privilege on platform_admins (read denied)", async () => {
    // information_schema.role_table_grants is the canonical source for
    // GRANTs. tenant_app must appear in NO row for platform_admins.
    const grants = await db.execute<{ privilege_type: string }>(sql`
      select privilege_type
        from information_schema.role_table_grants
       where grantee = ${TENANT_APP_ROLE}
         and table_schema = 'public'
         and table_name = 'platform_admins'
    `);
    expect(grants.rows).toEqual([]);

    // And the behavioural assertion: a session that has switched into
    // tenant_app errors with `permission denied for table`.
    await db.$client.exec(`set role ${TENANT_APP_ROLE};`);
    await expect(
      db.$client.query(`select 1 from platform_admins`),
    ).rejects.toThrow(/permission denied for table/i);
  });

  it("tenant_runtime has SELECT — the auth gate read works", async () => {
    const grants = await db.execute<{ privilege_type: string }>(sql`
      select privilege_type
        from information_schema.role_table_grants
       where grantee = 'tenant_runtime'
         and table_schema = 'public'
         and table_name = 'platform_admins'
    `);
    const privs = grants.rows.map((r) => r.privilege_type).sort();
    expect(privs).toEqual(["SELECT"]);
  });

  it("re-applying migration 0023 with the bootstrap GUC set is idempotent", async () => {
    await seedAdminUser(db);

    const bootstrapBlock = sql.raw(`
      DO $$
      DECLARE
        bootstrap_email  text := current_setting('app.platform_admin_bootstrap_email', true);
        target_user_id   uuid;
      BEGIN
        IF bootstrap_email IS NULL OR length(btrim(bootstrap_email)) = 0 THEN
          RETURN;
        END IF;
        SELECT id INTO target_user_id
          FROM users
         WHERE lower(email) = lower(btrim(bootstrap_email))
         LIMIT 1;
        IF target_user_id IS NULL THEN
          RETURN;
        END IF;
        INSERT INTO platform_admins (user_id, note)
             VALUES (target_user_id, 'bootstrap from PLATFORM_ADMIN_BOOTSTRAP_EMAIL')
        ON CONFLICT (user_id) DO NOTHING;
      END
      $$;
    `);

    // No GUC set → no-op (this is the "unset env" branch of the spec).
    await db.execute(bootstrapBlock);
    const empty = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from platform_admins`,
    );
    expect(Number(empty.rows[0]!.count)).toBe(0);

    // GUC set + matching user exists → one row inserted on first pass…
    await db.execute(
      sql`select set_config('app.platform_admin_bootstrap_email', ${ADMIN_EMAIL}, false)`,
    );
    await db.execute(bootstrapBlock);
    const first = await db.execute<{ user_id: string }>(
      sql`select user_id from platform_admins`,
    );
    expect(first.rows).toEqual([{ user_id: ADMIN_USER }]);

    // …and no-op on every subsequent re-apply (the idempotency drill).
    await db.execute(bootstrapBlock);
    await db.execute(bootstrapBlock);
    const second = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from platform_admins`,
    );
    expect(Number(second.rows[0]!.count)).toBe(1);

    await db.execute(sql.raw(`reset app.platform_admin_bootstrap_email`));
  });

  it("bootstrap is a no-op when the email does not match any user", async () => {
    await db.execute(
      sql`select set_config('app.platform_admin_bootstrap_email', 'ghost@example.test', false)`,
    );
    await db.execute(sql.raw(`
      DO $$
      DECLARE
        bootstrap_email  text := current_setting('app.platform_admin_bootstrap_email', true);
        target_user_id   uuid;
      BEGIN
        IF bootstrap_email IS NULL OR length(btrim(bootstrap_email)) = 0 THEN
          RETURN;
        END IF;
        SELECT id INTO target_user_id
          FROM users
         WHERE lower(email) = lower(btrim(bootstrap_email))
         LIMIT 1;
        IF target_user_id IS NULL THEN
          RETURN;
        END IF;
        INSERT INTO platform_admins (user_id, note)
             VALUES (target_user_id, 'bootstrap from PLATFORM_ADMIN_BOOTSTRAP_EMAIL')
        ON CONFLICT (user_id) DO NOTHING;
      END
      $$;
    `));
    const rows = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from platform_admins`,
    );
    expect(Number(rows.rows[0]!.count)).toBe(0);
    await db.execute(sql.raw(`reset app.platform_admin_bootstrap_email`));
  });
});
