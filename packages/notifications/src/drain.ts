/**
 * email_outbox drainer — H1.3 (PMB-17).
 *
 * Reads pending rows in created_at order, calls the injected `Mailer`,
 * marks each row `sent` (with sent_at) or `failed` (with error). Bounded
 * batch size so a single invocation cannot run forever.
 *
 * Re-entry safety: the cron route may invoke drain() multiple times in
 * a row if a previous run timed out. The status update happens AFTER
 * the send returns, so a crash mid-send may leave a row in `pending`
 * and be retried — which is the at-least-once delivery contract this
 * MVP targets. The sweep's idempotency guarantee bounds the worst case
 * to: same message sent twice. Use a real provider with idempotency
 * keys (Resend supports this via a future enhancement) to harden this.
 */

import { sql } from "drizzle-orm";

import { executeRows, type DbExecutor } from "./db.js";
import type { Mailer } from "./mailer.js";

export interface DrainResult {
  attempted: number;
  sent: number;
  failed: number;
}

export interface DrainOptions {
  /** Maximum rows to drain in one invocation. Defaults to 100. */
  batchSize?: number;
}

export async function drainEmailOutbox(
  db: DbExecutor,
  mailer: Mailer,
  options: DrainOptions = {},
): Promise<DrainResult> {
  const batchSize = options.batchSize ?? 100;

  const pending = await executeRows<{
    id: string;
    recipient_email: string;
    subject: string;
    body_text: string;
    body_html: string | null;
  }>(
    db,
    sql`
      select id, recipient_email, subject, body_text, body_html
        from email_outbox
       where status = 'pending'
       order by created_at asc
       limit ${batchSize}
    `,
  );

  let sent = 0;
  let failed = 0;

  for (const row of pending) {
    try {
      await mailer.send({
        to: row.recipient_email,
        subject: row.subject,
        text: row.body_text,
        ...(row.body_html ? { html: row.body_html } : {}),
      });
      await db.execute(sql`
        update email_outbox
           set status = 'sent', sent_at = now(), error = null
         where id = ${row.id}
      `);
      sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.execute(sql`
        update email_outbox
           set status = 'failed', error = ${message.slice(0, 1000)}
         where id = ${row.id}
      `);
      failed += 1;
    }
  }

  return { attempted: pending.length, sent, failed };
}
