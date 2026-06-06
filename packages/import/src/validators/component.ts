import { COMPONENT_KINDS } from "@ga/db";

import type { MappedRow } from "../parser-types.js";
import {
  finalize,
  foldMappingErrors,
  readString,
  type RowValidator,
  type ValidationError,
  type ValidatorContext,
} from "./types.js";

/**
 * C4 component validator. Pure / synchronous.
 *
 * Enforces:
 *   - kind, serialNumber — present.
 *   - kind is one of engine|propeller|appliance (mirrors
 *     `components_kind_check`).
 *   - tboHours, tboCalendarMonths, cycleLimit are parseable AND > 0
 *     when present. The mapping engine already coerces them; this
 *     validator catches the "parser produced null/NaN" and "value is
 *     present but ≤ 0" cases as LIFE_LIMIT_INVALID, mirroring the DB
 *     `components_tbo_*_pos` and `components_cycle_limit_pos`
 *     CHECK constraints.
 *
 * Note on "time-since-overhaul ≤ total time" from PMB-160:
 *   The V1 import target for `components` does NOT carry an
 *   installed-at total-time anchor or a current time-since-overhaul
 *   column (those live in `component_installations` and are derived
 *   from `aircraft.airframe_total_time` at compute time). So the
 *   ≤-total-time invariant is structurally enforced downstream: an
 *   active installation row references the aircraft's TT, and the
 *   compliance engine derives time-in-service from that anchor.
 *   The portion of this invariant the V1 importer CAN enforce is
 *   "life-limit fields parseable and positive" — that's what this
 *   validator does. The full installed-vs-TT cross-check lands when the
 *   installations importer ships.
 */
export const componentValidator: RowValidator<"component"> = {
  entity: "component",
  validate(row: MappedRow, ctx: ValidatorContext) {
    const errors: ValidationError[] = foldMappingErrors(row);

    const kind = readString(row, "kind");
    if (kind === null) {
      errors.push({
        rowNumber: ctx.rowNumber,
        code: "MISSING_REQUIRED_FIELD",
        message: "kind is required",
        field: "kind",
      });
    } else if (!(COMPONENT_KINDS as readonly string[]).includes(kind)) {
      errors.push({
        rowNumber: ctx.rowNumber,
        code: "INVALID_ENUM",
        message: `kind '${kind}' is not one of ${COMPONENT_KINDS.join(", ")}`,
        field: "kind",
      });
    }

    if (readString(row, "serialNumber") === null) {
      errors.push({
        rowNumber: ctx.rowNumber,
        code: "MISSING_REQUIRED_FIELD",
        message: "serialNumber is required",
        field: "serialNumber",
      });
    }

    checkLifeLimit(row, "tboHours", ctx, errors);
    checkLifeLimit(row, "tboCalendarMonths", ctx, errors);
    checkLifeLimit(row, "cycleLimit", ctx, errors);

    return finalize(errors);
  },
};

/**
 * Life-limit fields are optional, but if the operator supplied a value,
 * it MUST parse to a finite positive number. The mapping engine returns
 * null when coercion fails (with a MAPPING_ERROR appended); here we
 * additionally reject parsed-but-non-positive values (which the DB
 * CHECK constraints also reject).
 */
function checkLifeLimit(
  row: MappedRow,
  field: string,
  ctx: ValidatorContext,
  errors: ValidationError[],
): void {
  const raw = row.mapped[field];
  if (raw === undefined || raw === null) return;

  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    errors.push({
      rowNumber: ctx.rowNumber,
      code: "LIFE_LIMIT_INVALID",
      message: `${field} must be a finite number; got ${typeof raw}`,
      field,
    });
    return;
  }
  if (raw <= 0) {
    errors.push({
      rowNumber: ctx.rowNumber,
      code: "LIFE_LIMIT_INVALID",
      message: `${field} ${raw} must be > 0`,
      field,
    });
  }
}

