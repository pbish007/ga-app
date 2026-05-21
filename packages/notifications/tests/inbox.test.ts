/**
 * H1.4 — in-app inbox reads (PMB-17).
 */

import { describe, expect, it, beforeEach } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestDb, type TestDb } from "@ga/db";

import {
  listUnseenNotificationsForUser,
  markNotificationSeen,
} from "../src/inbox.js";

function asDb(db: TestDb) {
  return db as unknown as Parameters<typeof listUnseenNotificationsForUser>[0];
}

async function seed(db: TestDb): Promise<{
  tenantId: string;
  userId: string;
  notificationId: string;
}> {
  const regime = await db.execute<{ id: string }>(
    sql`select id from regimes where code = 'FAA'`,
  );
  const regimeId = regime.rows[0]!.id;
  const program = await db.execute<{ id: string }>(sql`
    select id from regime_inspection_program_templates
     where regime_id = ${regimeId} and code = 'annual'
  `);
  const programId = program.rows[0]!.id;

  const org = await db.execute<{ id: string }>(sql`
    insert into organizations (name, org_type, default_regime_id)
    values ('Inbox Tenant', 'owner', ${regimeId})
    returning id
  `);
  const tenantId = org.rows[0]!.id;

  const u = await db.execute<{ id: string }>(sql`
    insert into users (email) values ('alerts@test.local') returning id
  `);
  const userId = u.rows[0]!.id;

  const ac = await db.execute<{ id: string }>(sql`
    insert into aircraft (
      tenant_id, regime_id, registration, make, model, serial_number,
      category, aircraft_class, time_source
    ) values (
      ${tenantId}, ${regimeId}, 'N99', 'Piper', 'PA-28', 'SN-99',
      'normal', 'airplane_single_engine_land', 'hobbs'
    ) returning id
  `);
  const aircraftId = ac.rows[0]!.id;

  const n = await db.execute<{ id: string }>(sql`
    insert into notifications (
      tenant_id, user_id, aircraft_id, program_id, level,
      subject, body, cycle_key, deliver_email
    ) values (
      ${tenantId}, ${userId}, ${aircraftId}, ${programId}, 'overdue',
      'Overdue: Annual on N99', 'body text', 'cycle:1', false
    ) returning id
  `);
  return { tenantId, userId, notificationId: n.rows[0]!.id };
}

describe("H1.4 inbox (PMB-17)", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("lists unseen notifications and hides seen ones", async () => {
    const { userId, notificationId } = await seed(db);

    const before = await listUnseenNotificationsForUser(asDb(db), userId);
    expect(before).toHaveLength(1);
    expect(before[0]!.id).toBe(notificationId);
    expect(before[0]!.level).toBe("overdue");
    expect(before[0]!.subject).toContain("N99");

    const marked = await markNotificationSeen(asDb(db), userId, notificationId);
    expect(marked).toBe(true);

    const after = await listUnseenNotificationsForUser(asDb(db), userId);
    expect(after).toHaveLength(0);
  });

  it("markNotificationSeen returns false when the row is not the user's", async () => {
    const { notificationId } = await seed(db);
    const other = await db.execute<{ id: string }>(sql`
      insert into users (email) values ('other@test.local') returning id
    `);
    const marked = await markNotificationSeen(
      asDb(db),
      other.rows[0]!.id,
      notificationId,
    );
    expect(marked).toBe(false);
  });

  it("respects the limit argument", async () => {
    const { tenantId, userId } = await seed(db);
    const ac = await db.execute<{ id: string }>(sql`
      select id from aircraft where tenant_id = ${tenantId}
    `);
    const aircraftId = ac.rows[0]!.id;
    const program = await db.execute<{ id: string }>(sql`
      select id from regime_inspection_program_templates limit 1
    `);
    for (let i = 0; i < 3; i++) {
      await db.execute(sql`
        insert into notifications (
          tenant_id, user_id, aircraft_id, program_id, level,
          subject, body, cycle_key, deliver_email
        ) values (
          ${tenantId}, ${userId}, ${aircraftId}, ${program.rows[0]!.id}, 'due_soon',
          ${"S" + i}, 'b', ${"k" + i}, false
        )
      `);
    }
    const rows = await listUnseenNotificationsForUser(asDb(db), userId, 2);
    expect(rows).toHaveLength(2);
  });
});
