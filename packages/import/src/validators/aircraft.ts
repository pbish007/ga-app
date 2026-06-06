import { AIRCRAFT_TIME_SOURCES } from "@ga/db";

import type { MappedRow } from "../parser-types.js";
import {
  finalize,
  foldMappingErrors,
  readNumber,
  readString,
  type RowValidator,
  type ValidationError,
  type ValidatorContext,
} from "./types.js";

/**
 * FAA N-number grammar. Matches the spec literal in the PMB-160
 * acceptance:
 *
 *   ^N[1-9][0-9]{0,4}[A-Z]{0,2}$
 *
 * Rules captured: starts with `N`, first digit is 1-9 (no leading zero),
 * 0–4 additional digits, then 0–2 uppercase suffix letters. Total length
 * ranges from 2 (N1) to 7 (N12345AB).
 *
 * Other regimes substitute their own pattern through
 * {@link RegimeCatalog.registrationRegex}; if none is supplied the
 * validator does only a non-empty check (the operator gets a clear
 * MISSING_REQUIRED_FIELD instead of a format mismatch).
 */
export const FAA_REGISTRATION_REGEX = /^N[1-9][0-9]{0,4}[A-Z]{0,2}$/;

/**
 * C4 aircraft validator. Pure / synchronous.
 *
 * Enforces:
 *   - regimeId, registration, make, model, serialNumber, category,
 *     aircraftClass, timeSource — all present.
 *   - registration matches the regime's registration regex
 *     (FAA grammar by default).
 *   - yearManufactured, when present, is 1900..2100 (mirrors the
 *     `aircraft_year_manufactured_range` CHECK constraint).
 *   - airframeTotalTime, when present, is non-negative (mirrors
 *     `aircraft_airframe_total_time_nonneg`).
 *   - timeSource is one of the recognised values (mirrors
 *     `aircraft_time_source_check`).
 *
 * The validator catches these BEFORE the C5 commit pipeline tries the
 * INSERT, so the operator sees a per-cell error in the UI instead of a
 * Postgres constraint-violation back at the import-job level.
 */
export const aircraftValidator: RowValidator<"aircraft"> = {
  entity: "aircraft",
  validate(row: MappedRow, ctx: ValidatorContext) {
    const errors: ValidationError[] = foldMappingErrors(row);

    requireNonEmpty(row, "regimeId", ctx, errors);
    requireNonEmpty(row, "make", ctx, errors);
    requireNonEmpty(row, "model", ctx, errors);
    requireNonEmpty(row, "serialNumber", ctx, errors);
    requireNonEmpty(row, "category", ctx, errors);
    requireNonEmpty(row, "aircraftClass", ctx, errors);

    const registration = readString(row, "registration");
    if (registration === null) {
      errors.push({
        rowNumber: ctx.rowNumber,
        code: "MISSING_REQUIRED_FIELD",
        message: "registration is required",
        field: "registration",
      });
    } else {
      const re =
        ctx.regime.registrationRegex ?? defaultRegexForRegime(ctx.regime.code);
      if (re && !re.test(registration)) {
        errors.push({
          rowNumber: ctx.rowNumber,
          code: "INVALID_REGISTRATION",
          message: `registration '${registration}' does not match ${ctx.regime.code} grammar`,
          field: "registration",
        });
      }
    }

    const year = readNumber(row, "yearManufactured");
    if (year !== null && (year < 1900 || year > 2100)) {
      errors.push({
        rowNumber: ctx.rowNumber,
        code: "OUT_OF_RANGE",
        message: `yearManufactured ${year} must be between 1900 and 2100`,
        field: "yearManufactured",
      });
    }

    const airframeTotalTime = readNumber(row, "airframeTotalTime");
    if (airframeTotalTime !== null && airframeTotalTime < 0) {
      errors.push({
        rowNumber: ctx.rowNumber,
        code: "OUT_OF_RANGE",
        message: `airframeTotalTime ${airframeTotalTime} must be ≥ 0`,
        field: "airframeTotalTime",
      });
    }

    const timeSource = readString(row, "timeSource");
    if (timeSource === null) {
      errors.push({
        rowNumber: ctx.rowNumber,
        code: "MISSING_REQUIRED_FIELD",
        message: "timeSource is required",
        field: "timeSource",
      });
    } else if (
      !(AIRCRAFT_TIME_SOURCES as readonly string[]).includes(timeSource)
    ) {
      errors.push({
        rowNumber: ctx.rowNumber,
        code: "INVALID_ENUM",
        message: `timeSource '${timeSource}' is not one of ${AIRCRAFT_TIME_SOURCES.join(
          ", ",
        )}`,
        field: "timeSource",
      });
    }

    return finalize(errors);
  },
};

function defaultRegexForRegime(code: string): RegExp | undefined {
  if (code === "FAA") return FAA_REGISTRATION_REGEX;
  return undefined;
}

function requireNonEmpty(
  row: MappedRow,
  field: string,
  ctx: ValidatorContext,
  errors: ValidationError[],
): void {
  if (readString(row, field) === null) {
    errors.push({
      rowNumber: ctx.rowNumber,
      code: "MISSING_REQUIRED_FIELD",
      message: `${field} is required`,
      field,
    });
  }
}
