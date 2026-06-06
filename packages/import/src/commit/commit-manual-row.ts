import { eq, sql } from "drizzle-orm";

import {
  TENANT_APP_ROLE,
  TENANT_CONTEXT_GUC,
  schema as dbSchema,
} from "@ga/db";

import {
  createBatchState,
  entityToTargetTable,
  type RegimeCatalog,
  type ValidatorContext,
} from "../validators/types.js";
import { getValidator } from "../validators/index.js";
import { insertLiveRow } from "./inserters.js";
import {
  findCredentialByCertificateNumber,
  findRtsTemplate,
} from "./resolve.js";
import {
  ManualRowValidationError,
  type CommitManualRowInput,
  type ImportDb,
  type ImportTx,
  type ManualRowResult,
} from "./types.js";
import type { MappedRow } from "../parser-types.js";

const { importJobs, importJobRows, regimeRtsTemplates } = dbSchema;

/**
 * Manual-row reuse path (PMB-161 acceptance):
 *
 *   IngestionService.commitManualRow({ tenantId, entity, row })
 *
 * Runs the C4 validator on the supplied row, then writes a single-row
 * import job + staging row + live row inside ONE transaction. The same
 * inserter the spreadsheet path uses materializes the live row, so the
 * manual entry inherits the same audit trail (source_import_row_id
 * traceability, validation snapshot, signed-off shape for maintenance
 * entries).
 *
 * The validator uses the same DB-backed catalog the commit pipeline
 * uses for lookups, so a manual maintenance entry whose certificate or
 * RTS code doesn't resolve gets rejected before any live INSERT runs.
 */
export async function commitManualRow(
  db: ImportDb,
  input: CommitManualRowInput,
): Promise<ManualRowResult> {
  return await db.transaction(async (tx) => {
    await pinTenantTx(tx, input.tenantId);

    const regime = await loadRegimeCatalog(tx, input.regimeId, input.regimeCode);
    // The validator's cursor contract is synchronous, but the lookup
    // it would issue (certificate # → credential) is async-backed
    // in production. We PRE-RESOLVE the certificate before calling
    // the validator and expose the result through a thin in-memory
    // adapter so the validator stays sync.
    const cursor = await preResolveCursorState(tx, input);
    const validatorCtx: ValidatorContext = {
      tenantId: input.tenantId,
      regimeId: input.regimeId,
      rowNumber: 1,
      regime,
      cursor,
      batch: createBatchState(),
    };

    const row: MappedRow = { mapped: input.mapped, errors: [] };
    const validator = getValidator(input.entity);
    const result = validator.validate(row, validatorCtx);
    if (result.status !== "valid") {
      throw new ManualRowValidationError(result.errors);
    }

    // 1. Header job. Skip the pending/validating states — the row is
    //    already validated; mark it `ready` then immediately move on
    //    to the inserter, all inside this single tx.
    const sourceFilename = input.label ?? `manual_entry:${input.entity}`;
    const [job] = await tx
      .insert(importJobs)
      .values({
        tenantId: input.tenantId,
        state: "ready",
        importKind: `manual_${input.entity}`,
        sourceFilename,
        sourceDocumentId: input.sourceDocumentId ?? null,
        createdByUserId: input.userId,
        rowCount: 1,
      })
      .returning({ id: importJobs.id });

    // 2. Single staging row. mapped_payload == source_payload because
    //    the mapping_config for manual entries is the identity
    //    transform — there is no spreadsheet to translate from.
    const targetTable = entityToTargetTable(input.entity);
    const [stagedRow] = await tx
      .insert(importJobRows)
      .values({
        tenantId: input.tenantId,
        importJobId: job!.id,
        sourceRowNumber: 1,
        sourcePayload: input.mapped,
        mappedPayload: input.mapped,
        targetTable: targetTable as
          | "aircraft"
          | "maintenance_entries"
          | "components"
          | "flight_time_entries",
        validationStatus: "valid",
      })
      .returning({ id: importJobRows.id });

    // 3. Live INSERT via the shared inserter — same code path the
    //    spreadsheet commit uses.
    const liveId = await insertLiveRow(
      {
        tx,
        tenantId: input.tenantId,
        regimeId: input.regimeId,
        importRowId: stagedRow!.id,
        sourceRowNumber: 1,
        mapped: input.mapped,
      },
      targetTable,
    );

    // 4. Stamp the staging row with the committed record id + flip
    //    status. This makes the manual entry's audit trail identical
    //    to a one-row spreadsheet import.
    await tx
      .update(importJobRows)
      .set({
        committedRecordId: liveId,
        validationStatus: "committed",
        updatedAt: new Date(),
      })
      .where(eq(importJobRows.id, stagedRow!.id));

    // 5. Flip the job to committed.
    await tx
      .update(importJobs)
      .set({
        state: "committed",
        committedAt: new Date(),
        committedByUserId: input.userId,
        updatedAt: new Date(),
      })
      .where(eq(importJobs.id, job!.id));

    return {
      importJobId: job!.id,
      state: "committed",
      rowsCommitted: 1,
      alreadyCommitted: false,
      recordId: liveId,
    };
  });
}

async function pinTenantTx(tx: ImportTx, tenantId: string): Promise<void> {
  await tx.execute(
    sql`select set_config(${TENANT_CONTEXT_GUC}, ${tenantId}, true)`,
  );
  await tx.execute(sql.raw(`set local role ${TENANT_APP_ROLE}`));
}

async function loadRegimeCatalog(
  tx: ImportTx,
  regimeId: string,
  regimeCode: string,
): Promise<RegimeCatalog> {
  const rows = await tx
    .select({ code: regimeRtsTemplates.code })
    .from(regimeRtsTemplates)
    .where(eq(regimeRtsTemplates.regimeId, regimeId));
  const codes = new Set(rows.map((r) => r.code));
  return {
    regimeId,
    code: regimeCode,
    rts: { regimeId, codes },
  };
}

/**
 * The validator's cursor contract is synchronous. For the manual-row
 * path we pre-resolve the keys the validator actually consults
 * (certificate number → credential id + user id) by reading the DB
 * before validation, then expose them through a static cursor.
 *
 * Aircraft lookups by registration are not exercised in the manual
 * path — the operator-facing UI already supplies the `aircraftId` for
 * maintenance/flight-time entries (selected from a tenant-scoped
 * dropdown), so the validator only checks UUID shape, not membership.
 */
async function preResolveCursorState(
  tx: ImportTx,
  input: CommitManualRowInput,
): Promise<ValidatorContext["cursor"]> {
  const cert =
    typeof input.mapped.signedByCertificateNumber === "string"
      ? (input.mapped.signedByCertificateNumber as string)
      : null;
  const credential = cert
    ? await findCredentialByCertificateNumber(tx, cert)
    : null;
  return {
    aircraftIdByRegistration: () => null,
    credentialByCertificateNumber: (n: string) => {
      if (!cert) return null;
      if (n.toLowerCase() !== cert.toLowerCase()) return null;
      return credential ?? null;
    },
  };
}

// Surfaced for symmetry with the spreadsheet path's commit gate so
// callers know the catalog drift check exists.
export { findRtsTemplate };
