import { schema as dbSchema } from "@ga/db";

import type { AccountsDb } from "./db.js";

const { emailOutbox } = dbSchema;

export interface OutgoingEmail {
  /** Tenant the message belongs to; null for system-level mail. */
  tenantId: string | null;
  recipientEmail: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
}

export interface Mailer {
  send(message: OutgoingEmail): Promise<void>;
}

/**
 * Persists outbound mail into `email_outbox` so a real provider (SES,
 * Postmark, SMTP) can drain it asynchronously. Keeping the boundary
 * here lets request handlers stay synchronous and lets us retry without
 * losing mail.
 */
export class OutboxMailer implements Mailer {
  constructor(private readonly db: AccountsDb) {}

  async send(message: OutgoingEmail): Promise<void> {
    await this.db.insert(emailOutbox).values({
      tenantId: message.tenantId,
      recipientEmail: message.recipientEmail,
      subject: message.subject,
      bodyText: message.bodyText,
      bodyHtml: message.bodyHtml ?? null,
      status: "pending",
    });
  }
}
