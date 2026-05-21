/**
 * Notification templates — operational language only.
 *
 * F2 seam (spec §6): no regulatory text in app code. The strings here
 * tell the user WHAT IS HAPPENING with the inspection on their aircraft.
 * They never claim airworthiness, never reproduce return-to-service
 * language, and never quote regulations — those live in
 * regime_rts_templates and are only used by the sign-off flow.
 *
 * The §3.6 disclaimer is appended to every email body so even a
 * stand-alone email cannot be read as the software making an
 * airworthiness determination.
 */

import type { NotificationLevel } from "@ga/db";

export interface NotificationTemplateInput {
  registration: string;
  programName: string;
  // Pre-formatted human margin string, e.g. "in 12 days", "in 8.4 hours",
  // "overdue by 3 days". The sweep formats this so templates stay pure.
  marginPhrase: string;
}

export interface RenderedNotification {
  subject: string;
  body: string;
}

const DISCLAIMER =
  "This software reports compliance status only. Airworthiness " +
  "determination is the legal responsibility of the certificated " +
  "mechanic and the aircraft owner/operator.";

export function renderNotification(
  level: NotificationLevel,
  input: NotificationTemplateInput,
): RenderedNotification {
  if (level === "overdue") {
    return {
      subject: `Overdue: ${input.programName} on ${input.registration}`,
      body:
        `The ${input.programName} on ${input.registration} is ${input.marginPhrase}. ` +
        `Sign in to review the maintenance dashboard.\n\n` +
        DISCLAIMER,
    };
  }
  return {
    subject: `Due soon: ${input.programName} on ${input.registration}`,
    body:
      `The ${input.programName} on ${input.registration} is coming due ${input.marginPhrase}. ` +
      `Sign in to review the maintenance dashboard.\n\n` +
      DISCLAIMER,
  };
}

/**
 * Format the engine's IntervalDue into the user-facing margin phrase.
 * Operational language only; no regulatory claims.
 */
export function formatMarginPhrase(opts: {
  level: NotificationLevel;
  remainingDays: number | null;
  remainingHours: number | null;
  remainingCycles: number | null;
}): string {
  // Pick the smallest (most binding) margin.
  const candidates: Array<{ value: number; unit: string }> = [];
  if (opts.remainingDays !== null) {
    candidates.push({ value: opts.remainingDays, unit: "day" });
  }
  if (opts.remainingHours !== null) {
    candidates.push({ value: opts.remainingHours, unit: "hour" });
  }
  if (opts.remainingCycles !== null) {
    candidates.push({ value: opts.remainingCycles, unit: "cycle" });
  }
  if (candidates.length === 0) {
    return opts.level === "overdue" ? "overdue" : "coming due";
  }
  const best = candidates.reduce((a, b) =>
    Math.abs(a.value) <= Math.abs(b.value) ? a : b,
  );
  const magnitude = Math.abs(best.value);
  const rounded =
    best.unit === "cycle" ? Math.round(magnitude) : Math.round(magnitude * 10) / 10;
  const plural = rounded === 1 ? "" : "s";
  if (opts.level === "overdue") {
    return `overdue by ${rounded} ${best.unit}${plural}`;
  }
  return `in ${rounded} ${best.unit}${plural}`;
}
