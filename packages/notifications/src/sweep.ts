/**
 * Notification sweep — H1.2 (PMB-17).
 *
 * Walks the compliance due-list across every tenant and emits durable
 * `notifications` rows for every (user, aircraft, program) milestone
 * that has crossed into `due_soon` or `overdue`. For users whose
 * preferences allow email and whose configured lead time still wants
 * the alert, enqueues a parallel `email_outbox` row in the same
 * fan-out path so the two cannot drift.
 *
 * Idempotency contract:
 *   - The unique index on (tenant, user, aircraft, program, level,
 *     cycle_key) guarantees that the second sweep in a row inserts zero
 *     rows. If the notification insert collides we DELETE the
 *     speculative email we just enqueued, so we never double-send.
 *   - `cycle_key` is derived from the subscription state; when the
 *     inspection is signed off `lastCompliedAt` advances and the next
 *     sweep emits a fresh row for the new cycle. This is intentional.
 *
 * Connection model:
 *   - This is a cross-tenant batch job, not a per-request user action.
 *     The caller (cron route in apps/web) connects with the migrator /
 *     system role that bypasses RLS, and the sweep filters every query
 *     by tenant_id explicitly. We never SET ROLE tenant_app here — the
 *     `users` table has no tenant_app grant precisely because it is a
 *     global identity table, and the sweep needs to read it.
 *
 * Safety / spec discipline:
 *   - Subject + body come from `@ga/notifications/templates`, which is
 *     operational language only. No regulatory text. (F2 seam.)
 */

import { sql } from "drizzle-orm";

import {
  computeProgramDue,
  type IntervalDefinition,
  type ProgramDue,
} from "@ga/compliance";
import type { NotificationLevel } from "@ga/db";

import { executeRows, type DbExecutor } from "./db.js";
import { formatMarginPhrase, renderNotification } from "./templates.js";

export type SweepDb = DbExecutor;

export interface SweepResult {
  tenantsScanned: number;
  notificationsCreated: number;
  emailsEnqueued: number;
}

interface OrgRow {
  id: string;
}

interface AircraftRow {
  id: string;
  registration: string;
  airframe_total_time: string | number;
}

interface SubscriptionRow {
  id: string;
  aircraft_id: string;
  program_id: string;
  last_complied_at: Date | string | null;
  last_complied_airframe_time: string | number | null;
  last_complied_cycles: number | null;
  due_soon_days_threshold: number;
  due_soon_hours_threshold: string | number;
  created_at: Date | string;
}

interface IntervalRow {
  template_id: string;
  kind: string;
  value: string | number;
  unit: string;
}

interface ProgramTemplateRow {
  id: string;
  code: string;
  name: string;
}

interface UserPrefRow {
  user_id: string;
  email: string;
  email_lead_time_days: number;
  email_enabled: boolean;
}

const DEFAULT_EMAIL_LEAD_TIME_DAYS = 14;

/**
 * Run a single sweep across every tenant.
 *
 * `now` is injected so tests can pin time; the cron route passes
 * `new Date()`. The caller's connection must have privileges to read
 * users + organization_memberships and to write notifications +
 * email_outbox (i.e. NOT a tenant_app session).
 */
export async function runNotificationSweep(
  db: SweepDb,
  now: Date = new Date(),
): Promise<SweepResult> {
  const orgs = await executeRows<OrgRow>(db, sql`select id from organizations`);

  let notificationsCreated = 0;
  let emailsEnqueued = 0;

  for (const org of orgs) {
    const result = await sweepTenant(db, org.id, now);
    notificationsCreated += result.notificationsCreated;
    emailsEnqueued += result.emailsEnqueued;
  }

  return {
    tenantsScanned: orgs.length,
    notificationsCreated,
    emailsEnqueued,
  };
}

async function sweepTenant(
  tx: SweepDb,
  tenantId: string,
  now: Date,
): Promise<{ notificationsCreated: number; emailsEnqueued: number }> {
  const users = await executeRows<UserPrefRow>(
    tx,
    sql`
      select u.id as user_id,
             u.email as email,
             coalesce(p.email_lead_time_days, ${DEFAULT_EMAIL_LEAD_TIME_DAYS}) as email_lead_time_days,
             coalesce(p.email_enabled, true) as email_enabled
        from organization_memberships m
        join users u on u.id = m.user_id
        left join notification_preferences p
          on p.tenant_id = m.tenant_id and p.user_id = m.user_id
       where m.tenant_id = ${tenantId}
    `,
  );
  if (users.length === 0) {
    return { notificationsCreated: 0, emailsEnqueued: 0 };
  }

  const aircraft = await executeRows<AircraftRow>(
    tx,
    sql`
      select id, registration, airframe_total_time
        from aircraft
       where tenant_id = ${tenantId}
    `,
  );

  let notificationsCreated = 0;
  let emailsEnqueued = 0;

  for (const ac of aircraft) {
    const subs = await executeRows<SubscriptionRow>(
      tx,
      sql`
        select id,
               aircraft_id,
               program_id,
               last_complied_at,
               last_complied_airframe_time,
               last_complied_cycles,
               due_soon_days_threshold,
               due_soon_hours_threshold,
               created_at
          from aircraft_inspection_subscriptions
         where tenant_id = ${tenantId}
           and aircraft_id = ${ac.id}
           and active = true
      `,
    );

    for (const sub of subs) {
      const intervalRows = await executeRows<IntervalRow>(
        tx,
        sql`
          select template_id, kind, value, unit
            from regime_inspection_program_intervals
           where template_id = ${sub.program_id}
        `,
      );
      const intervals: IntervalDefinition[] = intervalRows.map((r) => ({
        kind: r.kind as IntervalDefinition["kind"],
        value: Number(r.value),
        unit: r.unit,
      }));

      const anchor = {
        at: toDate(sub.last_complied_at ?? sub.created_at),
        airframeTime:
          sub.last_complied_airframe_time !== null
            ? Number(sub.last_complied_airframe_time)
            : 0,
        cycles: sub.last_complied_cycles ?? 0,
      };
      const current = {
        now,
        airframeTime: Number(ac.airframe_total_time),
        cycles: 0,
      };
      const thresholds = {
        days: sub.due_soon_days_threshold,
        hours: Number(sub.due_soon_hours_threshold),
      };

      const programDue = computeProgramDue(intervals, anchor, current, thresholds);
      if (programDue.status === "ok" || programDue.driver === null) continue;

      const tplRows = await executeRows<ProgramTemplateRow>(
        tx,
        sql`
          select id, code, name
            from regime_inspection_program_templates
           where id = ${sub.program_id}
        `,
      );
      const tpl = tplRows[0];
      if (!tpl) continue;

      const fanout = await fanoutForProgram({
        tx,
        tenantId,
        users,
        aircraftId: ac.id,
        registration: ac.registration,
        program: tpl,
        subscriptionId: sub.id,
        lastCompliedAt: sub.last_complied_at,
        programDue,
      });

      notificationsCreated += fanout.notificationsCreated;
      emailsEnqueued += fanout.emailsEnqueued;
    }
  }

  return { notificationsCreated, emailsEnqueued };
}

async function fanoutForProgram(args: {
  tx: SweepDb;
  tenantId: string;
  users: UserPrefRow[];
  aircraftId: string;
  registration: string;
  program: ProgramTemplateRow;
  subscriptionId: string;
  lastCompliedAt: Date | string | null;
  programDue: ProgramDue;
}): Promise<{ notificationsCreated: number; emailsEnqueued: number }> {
  const driver = args.programDue.driver!;
  const level: NotificationLevel =
    args.programDue.status === "overdue" ? "overdue" : "due_soon";

  const cycleKey = buildCycleKey(args.subscriptionId, args.lastCompliedAt);
  const marginPhrase = formatMarginPhrase({
    level,
    remainingDays: driver.remainingDays,
    remainingHours: driver.remainingHours,
    remainingCycles: driver.remainingCycles,
  });
  const rendered = renderNotification(level, {
    registration: args.registration,
    programName: args.program.name,
    marginPhrase,
  });

  let notificationsCreated = 0;
  let emailsEnqueued = 0;

  for (const user of args.users) {
    const wantsEmail = shouldEmailUser({
      level,
      remainingDays: driver.remainingDays,
      emailEnabled: user.email_enabled,
      emailLeadTimeDays: user.email_lead_time_days,
    });

    let emailOutboxId: string | null = null;
    if (wantsEmail) {
      const enq = await executeRows<{ id: string }>(
        args.tx,
        sql`
          insert into email_outbox
            (tenant_id, recipient_email, subject, body_text, status)
          values
            (${args.tenantId}, ${user.email}, ${rendered.subject}, ${rendered.body}, 'pending')
          returning id
        `,
      );
      emailOutboxId = enq[0]?.id ?? null;
    }

    const ins = await executeRows<{ id: string }>(
      args.tx,
      sql`
        insert into notifications
          (tenant_id, user_id, aircraft_id, program_id, level, subject, body,
           cycle_key, deliver_email, email_outbox_id)
        values
          (${args.tenantId}, ${user.user_id}, ${args.aircraftId}, ${args.program.id},
           ${level}, ${rendered.subject}, ${rendered.body},
           ${cycleKey}, ${wantsEmail}, ${emailOutboxId})
        on conflict (tenant_id, user_id, aircraft_id, program_id, level, cycle_key)
        do nothing
        returning id
      `,
    );

    const inserted = ins.length > 0;
    if (inserted) {
      notificationsCreated += 1;
      if (wantsEmail) emailsEnqueued += 1;
    } else if (wantsEmail && emailOutboxId !== null) {
      // Notification already present from a prior sweep — undo the
      // speculative email enqueue so we don't double-send.
      await args.tx.execute(
        sql`delete from email_outbox where id = ${emailOutboxId}`,
      );
    }
  }

  return { notificationsCreated, emailsEnqueued };
}

function shouldEmailUser(args: {
  level: NotificationLevel;
  remainingDays: number | null;
  emailEnabled: boolean;
  emailLeadTimeDays: number;
}): boolean {
  if (!args.emailEnabled) return false;
  if (args.level === "overdue") return true;
  if (args.remainingDays !== null) {
    return args.remainingDays <= args.emailLeadTimeDays;
  }
  // Due-soon driven by hours/cycles: the per-subscription threshold has
  // already gated this. Fire.
  return true;
}

function buildCycleKey(
  subscriptionId: string,
  lastCompliedAt: Date | string | null,
): string {
  if (lastCompliedAt === null) return `${subscriptionId}:initial`;
  const d =
    lastCompliedAt instanceof Date ? lastCompliedAt : new Date(lastCompliedAt);
  return `${subscriptionId}:${d.toISOString()}`;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
