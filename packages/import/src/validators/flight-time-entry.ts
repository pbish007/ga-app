import type { MappedRow } from "../parser-types.js";
import {
  finalize,
  foldMappingErrors,
  readBoolean,
  readNumber,
  readString,
  type RowValidator,
  type ValidationError,
  type ValidatorContext,
} from "./types.js";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * C4 flight-time-entry validator. Pure / synchronous.
 *
 * Per-row rules:
 *   - aircraftId — present and uuid-shaped. The mapping engine resolves
 *     tail → aircraft_id via the `aircraft_by_registration` lookup; a
 *     LOOKUP_MISS surfaces as MAPPING_ERROR (folded in) AND a
 *     downstream `AIRCRAFT_NOT_RESOLVED` here, so the row goes invalid
 *     even if the operator is reading only the per-entity validator
 *     output.
 *   - airframeTimeNew — present, finite, ≥ 0 (mirrors the
 *     `fte_airframe_time_new_nonneg` DB CHECK).
 *   - overrideReason — required when isOverride=true (mirrors the
 *     `fte_override_reason_required` DB CHECK).
 *
 * Cross-row rule (monotonicity within the import batch): for a given
 * aircraft, every subsequent flight-time row MUST have an
 * `airframeTimeNew` ≥ the highest one already accepted for that
 * aircraft in this batch.
 *
 *   - Why: airframe TT is monotonic by definition (it counts up). A
 *     paper logbook transcribed out of order produces a backwards
 *     row, and the operator usually wants that flagged BEFORE commit.
 *   - Override seam: when `isOverride=true` AND `overrideReason` is
 *     populated, monotonicity is intentionally skipped — that matches
 *     the runtime "instrument swap / hour-meter replacement" path the
 *     Epic C flight log already supports.
 *   - State location: the orchestrator owns the
 *     {@link import("./types").BatchState} and passes it down; the
 *     validator never persists anything itself.
 */
export const flightTimeEntryValidator: RowValidator<"flight_time_entry"> = {
  entity: "flight_time_entry",
  validate(row: MappedRow, ctx: ValidatorContext) {
    const errors: ValidationError[] = foldMappingErrors(row);

    const aircraftId = readString(row, "aircraftId");
    if (aircraftId === null) {
      errors.push({
        rowNumber: ctx.rowNumber,
        code: "AIRCRAFT_NOT_RESOLVED",
        message:
          "aircraftId is required; the aircraft_by_registration lookup found no match for this row",
        field: "aircraftId",
      });
    } else if (!UUID_REGEX.test(aircraftId)) {
      errors.push({
        rowNumber: ctx.rowNumber,
        code: "INVALID_FORMAT",
        message: `aircraftId '${aircraftId}' is not a uuid`,
        field: "aircraftId",
      });
    }

    const airframeTimeNew = readNumber(row, "airframeTimeNew");
    if (airframeTimeNew === null) {
      errors.push({
        rowNumber: ctx.rowNumber,
        code: "MISSING_REQUIRED_FIELD",
        message: "airframeTimeNew is required",
        field: "airframeTimeNew",
      });
    } else if (airframeTimeNew < 0) {
      errors.push({
        rowNumber: ctx.rowNumber,
        code: "OUT_OF_RANGE",
        message: `airframeTimeNew ${airframeTimeNew} must be ≥ 0`,
        field: "airframeTimeNew",
      });
    }

    const isOverride = readBoolean(row, "isOverride") ?? false;
    const overrideReason = readString(row, "overrideReason");
    if (isOverride && overrideReason === null) {
      errors.push({
        rowNumber: ctx.rowNumber,
        code: "MISSING_REQUIRED_FIELD",
        message:
          "overrideReason is required when isOverride=true (instrument swap requires a reason)",
        field: "overrideReason",
      });
    }

    if (
      aircraftId !== null &&
      UUID_REGEX.test(aircraftId) &&
      airframeTimeNew !== null &&
      airframeTimeNew >= 0
    ) {
      enforceMonotonicity(
        aircraftId,
        airframeTimeNew,
        isOverride,
        overrideReason,
        ctx,
        errors,
      );
    }

    return finalize(errors);
  },
};

function enforceMonotonicity(
  aircraftId: string,
  airframeTimeNew: number,
  isOverride: boolean,
  overrideReason: string | null,
  ctx: ValidatorContext,
  errors: ValidationError[],
): void {
  if (!ctx.batch) return;

  const map = ctx.batch.highestAirframeTimeByAircraft;
  const prior = map.get(aircraftId);

  // Explicit override is allowed to go backwards (instrument swap).
  // The orchestrator still records the new high-water mark so a
  // subsequent non-override row that exceeds the override value
  // doesn't get flagged.
  if (isOverride && overrideReason !== null) {
    if (prior === undefined || airframeTimeNew > prior) {
      map.set(aircraftId, airframeTimeNew);
    }
    return;
  }

  if (prior !== undefined && airframeTimeNew < prior) {
    errors.push({
      rowNumber: ctx.rowNumber,
      code: "MONOTONICITY_VIOLATION",
      message: `airframeTimeNew ${airframeTimeNew} is below a prior row's ${prior} for this aircraft within this import batch (set isOverride=true with a reason if this is an instrument swap)`,
      field: "airframeTimeNew",
    });
    return;
  }

  // Accept and advance the cursor.
  if (prior === undefined || airframeTimeNew > prior) {
    map.set(aircraftId, airframeTimeNew);
  }
}
