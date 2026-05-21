/**
 * Mailer interface + adapters — H1.3 (PMB-17).
 *
 * Two implementations:
 *   - NullMailer: a no-op. Used in tests and when no provider env var is
 *     set. The email_outbox row stays `pending` so a future run picks it
 *     up once a sender is wired.
 *   - ResendMailer: thin HTTP adapter for resend.com. Chosen because
 *     it has a free tier, plain HTTP API (no SDK boot), good
 *     deliverability for transactional mail, and natively pairs with
 *     Vercel as a marketplace integration.
 *
 * Adding a second provider later means writing a sibling class — the
 * drainer (drain.ts) talks to this interface, never to a specific
 * provider.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailerResult {
  /** Provider-specific message id, when the provider returns one. */
  providerId: string | null;
}

export interface Mailer {
  send(message: MailMessage): Promise<MailerResult>;
}

/**
 * No-op mailer. Used in tests and when no provider is configured.
 * The drainer marks rows as `sent` after this returns so they don't
 * loop forever; if you want them to stay pending until a real provider
 * is configured, pass `markAsSent: false` to the drainer.
 */
export class NullMailer implements Mailer {
  async send(_message: MailMessage): Promise<MailerResult> {
    return { providerId: null };
  }
}

export interface ResendMailerOptions {
  apiKey: string;
  from: string;
  /** Override only for tests. */
  fetchImpl?: typeof fetch;
  /** Override only for tests. */
  endpoint?: string;
}

/**
 * Resend HTTP adapter. Plain fetch — no SDK dependency. Throws on
 * non-2xx so the drainer can mark the row `failed` and capture the
 * error message.
 */
export class ResendMailer implements Mailer {
  private readonly apiKey: string;
  private readonly from: string;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;

  constructor(opts: ResendMailerOptions) {
    if (!opts.apiKey) throw new Error("ResendMailer: apiKey is required");
    if (!opts.from) throw new Error("ResendMailer: from is required");
    this.apiKey = opts.apiKey;
    this.from = opts.from;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.endpoint = opts.endpoint ?? "https://api.resend.com/emails";
  }

  async send(message: MailMessage): Promise<MailerResult> {
    const res = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      }),
    });

    if (!res.ok) {
      const detail = await safeReadText(res);
      throw new Error(
        `Resend send failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`,
      );
    }

    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { providerId: data.id ?? null };
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
