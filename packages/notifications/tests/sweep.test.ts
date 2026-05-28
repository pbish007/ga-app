/**
 * H1.2 — notification sweep + idempotent fan-out (PMB-17).
 *
 * The unique-index contract is the safety property: re-running the same
 * sweep on the same world state cannot duplicate notifications and
 * cannot duplicate emails.
 */

import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestSuite, type TestDb } from "@ga/db";
import { runNotificationSweep, type SweepDb } from "../src/sweep.js";

// pglite + drizzle's execute return type satisfies the structural SweepDb
// type as long as we cast at the boundary. The test harness wires that.
function asSweepDb(db: TestDb): SweepDb {
  return db as unknown as SweepDb;
}

interface SeedResult {
  tenantId: string;
  userId: string;
  aircraftId: string;
  subscriptionId: string;
  programId: string;
  programName: string;
}

/**
 * Seed a single tenant with one user, one aircraft, and one calendar-driven
 * annual inspection subscription that is OVERDUE as of `now`.
 */
async function seedOverdueAnnual(
  db: TestDb,
  now: Date,
): Promise<SeedResult> {
  const regime = await db.execute<{ id: string }>(
    sql`select id from regimes where code = 'FAA'`,
  );
  const regimeId = regime.rows[0]!.id;

  const program = await db.execute<{ id: string; name: string }>(sql`
    select id, name from regime_inspection_program_templates
     where regime_id = ${regimeId} and code = 'annual'
  `);
  const programId = program.rows[0]!.id;
  const programName = program.rows[0]!.name;

  const orgs = await db.execute<{ id: string }>(sql`
    insert into organizations (name, org_type, default_regime_id)
    values ('Test Tenant', 'owner', ${regimeId})
    returning id
  `);
  const tenantId = orgs.rows[0]!.id;

  const users = await db.execute<{ id: string }>(sql`
    insert into users (email) values ('owner@test.local') returning id
  `);
  const userId = users.rows[0]!.id;

  await db.execute(sql`
    insert into organization_memberships (tenant_id, user_id, role)
    values (${tenantId}, ${userId}, 'admin')
  `);

  const ac = await db.execute<{ id: string }>(sql`
    insert into aircraft (
      tenant_id, regime_id, registration, make, model, serial_number,
      category, aircraft_class, time_source, airframe_total_time
    ) values (
      ${tenantId}, ${regimeId}, 'N12345', 'Cessna', '172P', 'SN-1',
      'normal', 'airplane_single_engine_land', 'hobbs', 4500.00
    ) returning id
  `);
  const aircraftId = ac.rows[0]!.id;

  // Annual = 12 calendar months. Anchor 2 years ago → overdue by ~12 months.
  const anchor = new Date(now);
  anchor.setUTCFullYear(anchor.getUTCFullYear() - 2);

  const sub = await db.execute<{ id: string }>(sql`
    insert into aircraft_inspection_subscriptions (
      tenant_id, aircraft_id, program_id, last_complied_at,
      last_complied_airframe_time, due_soon_days_threshold,
      due_soon_hours_threshold, active
    ) values (
      ${tenantId}, ${aircraftId}, ${programId}, ${anchor.toISOString()},
      4400.00, 30, 10, true
    ) returning id
  `);
  const subscriptionId = sub.rows[0]!.id;

  return { tenantId, userId, aircraftId, subscriptionId, programId, programName };
}

describe("H1.2 notification sweep — idempotent fan-out (PMB-17)", () => {
  let db: TestDb;
  let reset: () => Promise<void>;

  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });

  afterEach(async () => {
    await reset();
  });

  it("creates one overdue notification and one email row, then is a no-op on re-run", async () => {
    const now = new Date("2026-05-21T12:00:00Z");
    const seed = await seedOverdueAnnual(db, now);

    const first = await runNotificationSweep(asSweepDb(db), now);
    expect(first.tenantsScanned).toBe(1);
    expect(first.notificationsCreated).toBe(1);
    expect(first.emailsEnqueued).toBe(1);

    const notifs = await db.execute<{
      id: string;
      level: string;
      subject: string;
      cycle_key: string;
      deliver_email: boolean;
      email_outbox_id: string | null;
    }>(sql`select id, level, subject, cycle_key, deliver_email, email_outbox_id from notifications`);
    expect(notifs.rows).toHaveLength(1);
    expect(notifs.rows[0]!.level).toBe("overdue");
    expect(notifs.rows[0]!.subject).toMatch(/Overdue:.*N12345/);
    expect(notifs.rows[0]!.deliver_email).toBe(true);
    expect(notifs.rows[0]!.email_outbox_id).not.toBeNull();

    const emails = await db.execute<{ id: string; recipient_email: string; subject: string; status: string }>(
      sql`select id, recipient_email, subject, status from email_outbox`,
    );
    expect(emails.rows).toHaveLength(1);
    expect(emails.rows[0]!.recipient_email).toBe("owner@test.local");
    expect(emails.rows[0]!.status).toBe("pending");

    // Re-run on identical world state — nothing new should appear.
    const second = await runNotificationSweep(asSweepDb(db), now);
    expect(second.notificationsCreated).toBe(0);
    expect(second.emailsEnqueued).toBe(0);

    const notifsAfter = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from notifications`,
    );
    expect(Number(notifsAfter.rows[0]!.count)).toBe(1);
    const emailsAfter = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from email_outbox`,
    );
    expect(Number(emailsAfter.rows[0]!.count)).toBe(1);
  });

  it("emits a fresh notification when the inspection rolls forward (cycle_key changes)", async () => {
    const now = new Date("2026-05-21T12:00:00Z");
    const seed = await seedOverdueAnnual(db, now);

    await runNotificationSweep(asSweepDb(db), now);

    // Sign off the inspection — advance lastCompliedAt to today.
    await db.execute(sql`
      update aircraft_inspection_subscriptions
         set last_complied_at = ${now.toISOString()},
             last_complied_airframe_time = 4500.00
       where id = ${seed.subscriptionId}
    `);

    // Move "now" forward 11 months — annual interval is "due soon" now.
    const later = new Date(now);
    later.setUTCMonth(later.getUTCMonth() + 11);

    const second = await runNotificationSweep(asSweepDb(db), later);
    expect(second.notificationsCreated).toBe(1);

    const notifs = await db.execute<{ level: string; cycle_key: string }>(
      sql`select level, cycle_key from notifications order by created_at asc`,
    );
    expect(notifs.rows).toHaveLength(2);
    expect(notifs.rows[0]!.level).toBe("overdue");
    expect(notifs.rows[1]!.level).toBe("due_soon");
    expect(notifs.rows[0]!.cycle_key).not.toBe(notifs.rows[1]!.cycle_key);
  });

  it("respects per-user email_lead_time_days for due-soon (calendar)", async () => {
    const now = new Date("2026-05-21T12:00:00Z");
    const seed = await seedOverdueAnnual(db, now);

    // Roll the inspection forward so it's due-soon, 25 days from now.
    const anchor = new Date(now);
    anchor.setUTCDate(anchor.getUTCDate() - 340); // ~340 days ago, annual = 365 days
    await db.execute(sql`
      update aircraft_inspection_subscriptions
         set last_complied_at = ${anchor.toISOString()},
             last_complied_airframe_time = 4500.00
       where id = ${seed.subscriptionId}
    `);

    // User opted into very short lead time of 7 days — should NOT receive
    // an email yet (25 days out > 7), but the in-app row still posts.
    await db.execute(sql`
      insert into notification_preferences (tenant_id, user_id, email_lead_time_days, email_enabled)
      values (${seed.tenantId}, ${seed.userId}, 7, true)
    `);

    const res = await runNotificationSweep(asSweepDb(db), now);
    expect(res.notificationsCreated).toBe(1);
    expect(res.emailsEnqueued).toBe(0);

    const row = await db.execute<{ deliver_email: boolean; email_outbox_id: string | null }>(
      sql`select deliver_email, email_outbox_id from notifications`,
    );
    expect(row.rows[0]!.deliver_email).toBe(false);
    expect(row.rows[0]!.email_outbox_id).toBeNull();

    const emails = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from email_outbox`,
    );
    expect(Number(emails.rows[0]!.count)).toBe(0);
  });

  it("skips email when email_enabled is false but still posts in-app row", async () => {
    const now = new Date("2026-05-21T12:00:00Z");
    const seed = await seedOverdueAnnual(db, now);

    await db.execute(sql`
      insert into notification_preferences (tenant_id, user_id, email_lead_time_days, email_enabled)
      values (${seed.tenantId}, ${seed.userId}, 14, false)
    `);

    const res = await runNotificationSweep(asSweepDb(db), now);
    expect(res.notificationsCreated).toBe(1);
    expect(res.emailsEnqueued).toBe(0);

    const notif = await db.execute<{ deliver_email: boolean }>(
      sql`select deliver_email from notifications`,
    );
    expect(notif.rows[0]!.deliver_email).toBe(false);
  });

  it("fans out one notification per user in the tenant", async () => {
    const now = new Date("2026-05-21T12:00:00Z");
    const seed = await seedOverdueAnnual(db, now);

    // Add a second user to the same tenant.
    const u2 = await db.execute<{ id: string }>(sql`
      insert into users (email) values ('mechanic@test.local') returning id
    `);
    await db.execute(sql`
      insert into organization_memberships (tenant_id, user_id, role)
      values (${seed.tenantId}, ${u2.rows[0]!.id}, 'mechanic')
    `);

    const res = await runNotificationSweep(asSweepDb(db), now);
    expect(res.notificationsCreated).toBe(2);

    const notifs = await db.execute<{ user_id: string }>(
      sql`select user_id from notifications order by user_id`,
    );
    expect(notifs.rows).toHaveLength(2);
    const ids = new Set(notifs.rows.map((r) => r.user_id));
    expect(ids.size).toBe(2);
  });

  it("does nothing for tenants with no aircraft", async () => {
    const now = new Date("2026-05-21T12:00:00Z");
    const regime = await db.execute<{ id: string }>(
      sql`select id from regimes where code = 'FAA'`,
    );
    await db.execute(sql`
      insert into organizations (name, org_type, default_regime_id)
      values ('Empty Tenant', 'shop', ${regime.rows[0]!.id})
    `);

    const res = await runNotificationSweep(asSweepDb(db), now);
    expect(res.tenantsScanned).toBe(1);
    expect(res.notificationsCreated).toBe(0);
    expect(res.emailsEnqueued).toBe(0);
  });
});
