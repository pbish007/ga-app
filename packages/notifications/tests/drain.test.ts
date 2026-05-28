/**
 * H1.3 — email_outbox drain (PMB-17).
 *
 * Covers the contract: pending rows are mailed in order, success marks
 * them sent, failure marks them failed with the captured error. ResendMailer
 * is exercised through a fake fetch.
 */

import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestSuite, type TestDb } from "@ga/db";

import { drainEmailOutbox } from "../src/drain.js";
import {
  NullMailer,
  ResendMailer,
  type MailMessage,
  type Mailer,
  type MailerResult,
} from "../src/mailer.js";
import type { SweepDb } from "../src/sweep.js";

function asSweepDb(db: TestDb): SweepDb {
  return db as unknown as SweepDb;
}

async function seedTenant(db: TestDb): Promise<string> {
  const regime = await db.execute<{ id: string }>(
    sql`select id from regimes where code = 'FAA'`,
  );
  const orgs = await db.execute<{ id: string }>(sql`
    insert into organizations (name, org_type, default_regime_id)
    values ('Drain Tenant', 'owner', ${regime.rows[0]!.id})
    returning id
  `);
  return orgs.rows[0]!.id;
}

async function enqueue(
  db: TestDb,
  tenantId: string,
  recipient: string,
  subject: string,
): Promise<string> {
  const res = await db.execute<{ id: string }>(sql`
    insert into email_outbox (tenant_id, recipient_email, subject, body_text)
    values (${tenantId}, ${recipient}, ${subject}, 'body')
    returning id
  `);
  return res.rows[0]!.id;
}

describe("H1.3 drainEmailOutbox (PMB-17)", () => {
  let db: TestDb;
  let reset: () => Promise<void>;

  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });

  afterEach(async () => {
    await reset();
  });

  it("marks rows sent when the mailer succeeds, in created_at order", async () => {
    const tenantId = await seedTenant(db);
    await enqueue(db, tenantId, "first@test.local", "First");
    await enqueue(db, tenantId, "second@test.local", "Second");

    const seen: string[] = [];
    const mailer: Mailer = {
      async send(m: MailMessage): Promise<MailerResult> {
        seen.push(m.subject);
        return { providerId: `msg-${seen.length}` };
      },
    };

    const result = await drainEmailOutbox(asSweepDb(db), mailer);
    expect(result.attempted).toBe(2);
    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
    expect(seen).toEqual(["First", "Second"]);

    const rows = await db.execute<{ subject: string; status: string; error: string | null }>(
      sql`select subject, status, error from email_outbox order by created_at asc`,
    );
    expect(rows.rows.every((r) => r.status === "sent")).toBe(true);
    expect(rows.rows.every((r) => r.error === null)).toBe(true);
  });

  it("marks the row failed with the error message when the mailer throws", async () => {
    const tenantId = await seedTenant(db);
    await enqueue(db, tenantId, "boom@test.local", "Subject");

    const mailer: Mailer = {
      async send(): Promise<MailerResult> {
        throw new Error("upstream 503");
      },
    };

    const result = await drainEmailOutbox(asSweepDb(db), mailer);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);

    const rows = await db.execute<{ status: string; error: string | null }>(
      sql`select status, error from email_outbox`,
    );
    expect(rows.rows[0]!.status).toBe("failed");
    expect(rows.rows[0]!.error).toContain("upstream 503");
  });

  it("respects batchSize", async () => {
    const tenantId = await seedTenant(db);
    for (let i = 0; i < 5; i++) {
      await enqueue(db, tenantId, `u${i}@test.local`, `S${i}`);
    }

    const result = await drainEmailOutbox(asSweepDb(db), new NullMailer(), {
      batchSize: 2,
    });
    expect(result.attempted).toBe(2);
    expect(result.sent).toBe(2);

    const counts = await db.execute<{ status: string; count: string }>(
      sql`select status, count(*)::text as count from email_outbox group by status`,
    );
    const byStatus = Object.fromEntries(counts.rows.map((r) => [r.status, Number(r.count)]));
    expect(byStatus["sent"]).toBe(2);
    expect(byStatus["pending"]).toBe(3);
  });

  it("ResendMailer posts the expected payload and returns the provider id", async () => {
    const captured: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      captured.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "resend-msg-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as Response;
    };

    const mailer = new ResendMailer({
      apiKey: "re_test_key",
      from: "alerts@ga-app.test",
      fetchImpl: fakeFetch,
    });
    const result = await mailer.send({
      to: "owner@test.local",
      subject: "Hello",
      text: "body",
    });
    expect(result.providerId).toBe("resend-msg-1");
    expect(captured).toHaveLength(1);
    const body = JSON.parse(String(captured[0]!.init!.body));
    expect(body.from).toBe("alerts@ga-app.test");
    expect(body.to).toBe("owner@test.local");
    expect(body.subject).toBe("Hello");
    expect(body.text).toBe("body");
    expect(
      (captured[0]!.init!.headers as Record<string, string>).Authorization,
    ).toBe("Bearer re_test_key");
  });

  it("ResendMailer throws on non-2xx with the status text", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response("rate limited", { status: 429, statusText: "Too Many Requests" }) as Response;

    const mailer = new ResendMailer({
      apiKey: "re_test_key",
      from: "alerts@ga-app.test",
      fetchImpl: fakeFetch,
    });
    await expect(
      mailer.send({ to: "x@test.local", subject: "s", text: "t" }),
    ).rejects.toThrow(/429/);
  });
});
