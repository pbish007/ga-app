/**
 * Regime-agnostic compliance interval engine.
 *
 * This module has zero dependencies on database drivers, regimes, or
 * frameworks. All inputs are plain TypeScript values; callers do the
 * (DB row → engine type) conversion.
 *
 * Safety note (spec §3.4): defects here can ground a legal aircraft or
 * present an illegal one as airworthy. Every branch is covered by the
 * companion test suite. Do not add inline regulatory logic — that belongs
 * in regime-keyed templates (F2 seam).
 */

import {
  type CalendarUnit,
  type ComplianceAnchor,
  type ComplianceCurrent,
  type ComplianceStatus,
  type DueSoonThresholds,
  type IntervalDefinition,
  type IntervalDue,
  type ProgramDue,
} from "./types.js";

// ---------------------------------------------------------------------------
// Calendar arithmetic
// ---------------------------------------------------------------------------

function addCalendar(base: Date, value: number, unit: CalendarUnit): Date {
  const d = new Date(base);
  switch (unit) {
    case "days":
      d.setUTCDate(d.getUTCDate() + value);
      break;
    case "months":
      d.setUTCMonth(d.getUTCMonth() + value);
      break;
    case "years":
      d.setUTCFullYear(d.getUTCFullYear() + value);
      break;
  }
  return d;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MS_PER_DAY;
}

// ---------------------------------------------------------------------------
// Single-interval computation
// ---------------------------------------------------------------------------

const VALID_CALENDAR_UNITS: ReadonlySet<string> = new Set([
  "days",
  "months",
  "years",
]);

export function computeIntervalDue(
  interval: IntervalDefinition,
  anchor: ComplianceAnchor,
  current: ComplianceCurrent,
  thresholds: DueSoonThresholds,
): IntervalDue {
  const { kind, value, unit } = interval;

  switch (kind) {
    case "hour": {
      const dueAtAirframeTime = anchor.airframeTime + value;
      const remainingHours = dueAtAirframeTime - current.airframeTime;
      const status = resolveStatus(
        remainingHours,
        thresholds.hours,
      );
      return {
        interval,
        dueAt: null,
        dueAtAirframeTime,
        dueAtCycles: null,
        remainingDays: null,
        remainingHours,
        remainingCycles: null,
        status,
      };
    }

    case "calendar": {
      if (!VALID_CALENDAR_UNITS.has(unit)) {
        throw new Error(
          `Invalid calendar unit "${unit}". Must be one of: days, months, years.`,
        );
      }
      const dueAt = addCalendar(anchor.at, value, unit as CalendarUnit);
      const remainingDays = daysBetween(current.now, dueAt);
      const status = resolveStatus(remainingDays, thresholds.days);
      return {
        interval,
        dueAt,
        dueAtAirframeTime: null,
        dueAtCycles: null,
        remainingDays,
        remainingHours: null,
        remainingCycles: null,
        status,
      };
    }

    case "cycle": {
      const dueAtCycles = anchor.cycles + value;
      const remainingCycles = dueAtCycles - current.cycles;
      const status =
        thresholds.cycles !== undefined
          ? resolveStatus(remainingCycles, thresholds.cycles)
          : remainingCycles < 0
            ? "overdue"
            : "ok";
      return {
        interval,
        dueAt: null,
        dueAtAirframeTime: null,
        dueAtCycles,
        remainingDays: null,
        remainingHours: null,
        remainingCycles,
        status,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Status resolution
// ---------------------------------------------------------------------------

function resolveStatus(
  remaining: number,
  dueSoonThreshold: number,
): ComplianceStatus {
  if (remaining < 0) return "overdue";
  if (remaining <= dueSoonThreshold) return "due_soon";
  return "ok";
}

// ---------------------------------------------------------------------------
// Status ranking — used to pick the "worst" driver
// ---------------------------------------------------------------------------

const STATUS_RANK: Record<ComplianceStatus, number> = {
  overdue: 2,
  due_soon: 1,
  ok: 0,
};

function worstStatus(a: ComplianceStatus, b: ComplianceStatus): ComplianceStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Program-level computation (whichever-comes-first logic lives here)
// ---------------------------------------------------------------------------

/**
 * Compute the aggregate due state for an inspection program.
 *
 * For programs with multiple intervals the driver is chosen by:
 *   1. Worst status (overdue > due_soon > ok).
 *   2. When statuses tie, the interval with the smallest remaining
 *      normalised margin (hours for hour, days for calendar, cycles for
 *      cycle) wins — i.e. the one coming due soonest.
 *
 * For a program with zero intervals (custom cadence) the driver is null
 * and the status is "ok" — the engine has no opinion on custom programs.
 */
export function computeProgramDue(
  intervals: IntervalDefinition[],
  anchor: ComplianceAnchor,
  current: ComplianceCurrent,
  thresholds: DueSoonThresholds,
): ProgramDue {
  if (intervals.length === 0) {
    return { driver: null, status: "ok", intervals: [] };
  }

  const computed = intervals.map((iv) =>
    computeIntervalDue(iv, anchor, current, thresholds),
  );

  const driver = computed.reduce((best, candidate) => {
    const bRank = STATUS_RANK[best.status];
    const cRank = STATUS_RANK[candidate.status];
    if (cRank > bRank) return candidate;
    if (cRank < bRank) return best;
    // Tie-break: earliest remaining (smallest margin wins).
    const bMargin = primaryMargin(best);
    const cMargin = primaryMargin(candidate);
    return cMargin < bMargin ? candidate : best;
  });

  const status = driver.status;

  return { driver, status, intervals: computed };
}

function primaryMargin(due: IntervalDue): number {
  if (due.remainingHours !== null) return due.remainingHours;
  if (due.remainingDays !== null) return due.remainingDays;
  if (due.remainingCycles !== null) return due.remainingCycles;
  return Infinity;
}

// ---------------------------------------------------------------------------
// Aircraft-level airworthiness rollup
// ---------------------------------------------------------------------------

/**
 * Returns the aggregate airworthiness status across all program results
 * for a single aircraft. Regime-agnostic: callers pass in pre-computed
 * ProgramDue results and this function collapses them into a single status.
 *
 * "Airworthy" = every tracked program is "ok" or "due_soon".
 * "Not airworthy" = at least one program is "overdue".
 *
 * The UI and API must never state that the aircraft IS airworthy — they
 * must display this result alongside the spec §3.6 disclaimer that the
 * certificated mechanic and owner/operator remain legally responsible.
 */
export function rollupAirworthiness(
  programResults: ProgramDue[],
): ComplianceStatus {
  return programResults.reduce<ComplianceStatus>(
    (worst, p) => worstStatus(worst, p.status),
    "ok",
  );
}
