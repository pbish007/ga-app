import { MAINTENANCE_ENTRY_TYPES } from "@ga/db";

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

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * C4 maintenance-entry validator. Pure / synchronous.
 *
 * Enforces, for every row:
 *   - aircraftId, entryType, workPerformed, performedOn,
 *     aircraftTotalTime — present.
 *   - entryType is one of the closed set
 *     (`MAINTENANCE_ENTRY_TYPES`).
 *   - aircraftTotalTime is finite and ≥ 0 (mirrors
 *     `maintenance_entries_airframe_nonneg`).
 *
 * Sign-off shape (the PMB-160 acceptance gate): the V1 importer is the
 * historical-migration path, so every row MUST land already signed.
 * That means:
 *   - signedAt — present, parseable datetime.
 *   - signedByCertificateNumber — present, non-empty.
 *   - rtsTemplateCode — present, non-empty, AND match a code in the
 *     regime's RTS template catalog (case-insensitive).
 *
 * Beyond those shape checks the validator also confirms the
 * certificate number resolves through the tenant cursor
 * (`UNKNOWN_CERTIFICATE` on miss). The C5 commit pipeline uses the
 * resolved `credentialId` / `userId` to populate the DB sign-off
 * columns inside the same transaction.
 *
 * Why upfront? PMB-160 spec: the importer is forbidden to mint
 * unsigned historical entries. The sign() flow (Epic F) is the
 * interactive draft-and-release path for present-day maintenance work,
 * not a backfill seam.
 */
export const maintenanceEntryValidator: RowValidator<"maintenance_entry"> = {
  entity: "maintenance_entry",
  validate(row: MappedRow, ctx: ValidatorContext) {
    const errors: ValidationError[] = foldMappingErrors(row);

    const aircraftId = readString(row, "aircraftId");
    if (aircraftId === null) {
      errors.push({
        rowNumber: ctx.rowNumber,
        code: "MISSING_REQUIRED_FIELD",
        message: "aircraftId is required",
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

    const entryType = readString(row, "entryType");
    if (entryType === null) {
      errors.push({
        rowNumber: ctx.rowNumber,
        code: "MISSING_REQUIRED_FIELD",
        message: "entryType is required",
        field: "entryType",
      });
    } else if (
      !(MAINTENANCE_ENTRY_TYPES as readonly string[]).includes(entryType)
    ) {
      errors.push({
        rowNumber: ctx.rowNumber,
        code: "INVALID_ENUM",
        message: `entryType '${entryType}' is not one of ${MAINTENANCE_ENTRY_TYPES.join(
          ", ",
        )}`,
        field: "entryType",
      });
    }

    if (readString(row, "workPerformed") === null) {
      errors.push({
        rowNumber: ctx.rowNumber,
        code: "MISSING_REQUIRED_FIELD",
        message: "workPerformed is required",
        field: "workPerformed",
      });
    }

    if (readString(row, "performedOn") === null) {
      errors.push({
        rowNumber: ctx.rowNumber,
        code: "MISSING_REQUIRED_FIELD",
        message: "performedOn is required",
        field: "performedOn",
      });
    }

    const aircraftTotalTime = readNumber(row, "aircraftTotalTime");
    if (aircraftTotalTime === null) {
      errors.push({
        rowNumber: ctx.rowNumber,
        code: "MISSING_REQUIRED_FIELD",
        message: "aircraftTotalTime is required",
        field: "aircraftTotalTime",
      });
    } else if (aircraftTotalTime < 0) {
      errors.push({
        rowNumber: ctx.rowNumber,
        code: "OUT_OF_RANGE",
        message: `aircraftTotalTime ${aircraftTotalTime} must be ≥ 0`,
        field: "aircraftTotalTime",
      });
    }

    enforceSignOffShape(row, ctx, errors);

    return finalize(errors);
  },
};

function enforceSignOffShape(
  row: MappedRow,
  ctx: ValidatorContext,
  errors: ValidationError[],
): void {
  const signedAt = readString(row, "signedAt");
  const certificateNumber = readString(row, "signedByCertificateNumber");
  const rtsCode = readString(row, "rtsTemplateCode");

  const missing: string[] = [];
  if (signedAt === null) missing.push("signedAt");
  if (certificateNumber === null) missing.push("signedByCertificateNumber");
  if (rtsCode === null) missing.push("rtsTemplateCode");

  if (missing.length > 0) {
    errors.push({
      rowNumber: ctx.rowNumber,
      code: "UNSIGNED_HISTORICAL",
      message: `historical maintenance entries must be supplied fully signed; missing ${missing.join(", ")}`,
    });
    // Even with missing pieces, still surface specific sub-errors when
    // we have enough to check (helps the per-cell UI highlight the
    // right cells).
  }

  if (rtsCode !== null) {
    const codeSet = ctx.regime.rts.codes;
    const matched = lookupCodeCaseInsensitive(codeSet, rtsCode);
    if (!matched) {
      errors.push({
        rowNumber: ctx.rowNumber,
        code: "UNKNOWN_RTS_TEMPLATE",
        message: `rtsTemplateCode '${rtsCode}' is not in the ${ctx.regime.code} RTS template catalog`,
        field: "rtsTemplateCode",
      });
    }
  }

  if (certificateNumber !== null) {
    const resolved =
      ctx.cursor.credentialByCertificateNumber(certificateNumber);
    if (resolved === null) {
      errors.push({
        rowNumber: ctx.rowNumber,
        code: "UNKNOWN_CERTIFICATE",
        message: `signedByCertificateNumber '${certificateNumber}' does not match any active credential`,
        field: "signedByCertificateNumber",
      });
    }
  }
}

/**
 * RTS template codes are matched case-insensitively per the F2 contract.
 * Build a folded view of the catalog once per call; for V1 catalogs the
 * set is small (≈10s of entries), so this cost is negligible.
 */
function lookupCodeCaseInsensitive(
  codes: ReadonlySet<string>,
  candidate: string,
): boolean {
  const folded = candidate.toLowerCase();
  for (const c of codes) {
    if (c.toLowerCase() === folded) return true;
  }
  return false;
}
