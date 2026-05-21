/**
 * Compliance engine types — the pure data shapes the interval engine
 * consumes and returns. Nothing here imports a database driver, regime
 * package, or framework; the engine is a regime-agnostic library.
 *
 * The shapes are intentionally close to the persisted shapes in
 * `regime_inspection_program_intervals` and
 * `aircraft_inspection_subscriptions`, but adapters in callers do the
 * (string → number, Date → Date) conversion so the engine never sees
 * a string-typed numeric or a database row.
 */

export const INTERVAL_KINDS = ["hour", "calendar", "cycle"] as const;
export type IntervalKind = (typeof INTERVAL_KINDS)[number];

export const CALENDAR_UNITS = ["days", "months", "years"] as const;
export type CalendarUnit = (typeof CALENDAR_UNITS)[number];

export const COMPLIANCE_STATUSES = [
  "ok",
  "due_soon",
  "overdue",
] as const;
export type ComplianceStatus = (typeof COMPLIANCE_STATUSES)[number];

/** Definition of a single interval on an inspection program. */
export interface IntervalDefinition {
  kind: IntervalKind;
  value: number;
  /**
   * Unit string. For kind="calendar" must be one of {@link CalendarUnit}.
   * For kind="hour" the convention is "hours". For kind="cycle" the
   * convention is "cycles". The engine validates calendar units.
   */
  unit: string;
}

/**
 * The reference point against which the engine measures "since the last
 * sign-off." Callers compute this from the subscription row:
 *   - `at`           = subscription.lastCompliedAt ?? subscription.createdAt
 *   - `airframeTime` = subscription.lastCompliedAirframeTime ?? 0
 *   - `cycles`       = subscription.lastCompliedCycles ?? 0
 * The engine does not impose a convention; the caller chooses.
 */
export interface ComplianceAnchor {
  at: Date;
  airframeTime: number;
  cycles: number;
}

/** Aircraft state as of "now" — the engine reads these to compute margins. */
export interface ComplianceCurrent {
  now: Date;
  airframeTime: number;
  cycles: number;
}

/**
 * Configurable warning thresholds (AC: "Due-soon thresholds are
 * configurable"). When the margin to due-at falls at or below the
 * threshold (and the interval is not yet overdue), the status becomes
 * `due_soon`. Cycles threshold is optional — when omitted, cycle
 * intervals never enter `due_soon` and flip straight to `overdue`.
 */
export interface DueSoonThresholds {
  days: number;
  hours: number;
  cycles?: number;
}

export interface IntervalDue {
  interval: IntervalDefinition;
  /**
   * For `calendar` intervals this is the date at which the interval
   * comes due. For non-calendar intervals it is null — see
   * `dueAtAirframeTime` or `dueAtCycles` instead.
   */
  dueAt: Date | null;
  dueAtAirframeTime: number | null;
  dueAtCycles: number | null;
  /**
   * Remaining margins. The driver value (e.g. remainingDays for a
   * calendar interval) is always populated; the others are null for
   * that interval. Margin can be negative (interval is overdue).
   */
  remainingDays: number | null;
  remainingHours: number | null;
  remainingCycles: number | null;
  status: ComplianceStatus;
}

/**
 * Aggregate result for a single inspection program. `driver` is the
 * interval that determines the program's overall status — for
 * whichever-comes-first that is the earliest-due interval. For a
 * `custom` program with no intervals, `driver` is null and the
 * program is considered `ok` (engine has no opinion; operator owns
 * the cadence).
 */
export interface ProgramDue {
  driver: IntervalDue | null;
  status: ComplianceStatus;
  intervals: IntervalDue[];
}
