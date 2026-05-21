/**
 * In-app notification reads (H1.4). The dashboard surfaces unseen rows
 * for the current user; "mark seen" clears the badge.
 *
 * Per spec §4 Epic H: in-app alerts are always on. There is no opt-out.
 */

import { sql } from "drizzle-orm";

import { executeRows, type DbExecutor } from "./db.js";

export type NotificationReadTx = DbExecutor;

export interface UnseenNotification {
  id: string;
  level: "due_soon" | "overdue";
  subject: string;
  body: string;
  aircraftId: string;
  programId: string;
  createdAt: Date;
}

export async function listUnseenNotificationsForUser(
  tx: NotificationReadTx,
  userId: string,
  limit = 50,
): Promise<UnseenNotification[]> {
  const rows = await executeRows<{
    id: string;
    level: "due_soon" | "overdue";
    subject: string;
    body: string;
    aircraft_id: string;
    program_id: string;
    created_at: Date | string;
  }>(
    tx,
    sql`
      select id, level, subject, body, aircraft_id, program_id, created_at
        from notifications
       where user_id = ${userId}
         and seen_at is null
       order by created_at desc
       limit ${limit}
    `,
  );

  return rows.map((r) => ({
    id: r.id,
    level: r.level,
    subject: r.subject,
    body: r.body,
    aircraftId: r.aircraft_id,
    programId: r.program_id,
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
  }));
}

export async function markNotificationSeen(
  tx: NotificationReadTx,
  userId: string,
  notificationId: string,
): Promise<boolean> {
  const rows = await executeRows<{ id: string }>(
    tx,
    sql`
      update notifications
         set seen_at = now()
       where id = ${notificationId}
         and user_id = ${userId}
         and seen_at is null
      returning id
    `,
  );
  return rows.length > 0;
}
