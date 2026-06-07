import { Readable } from "node:stream";

import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import {
  IMPORT_JOB_TARGET_TABLES,
  schema as dbSchema,
  type ImportJobTargetTable,
  type ImportJobState,
} from "@ga/db";
import {
  FAA_REGISTRATION_REGEX,
  IngestionService,
  ImportJobCommitFailedError,
  ImportJobHasInvalidRowsError,
  ImportJobNotCommitableError,
  XlsxArchiveRejectedError,
  applyMapping,
  createBatchState,
  getValidator,
  inspectXlsxArchive,
  parseCsv,
  parseXlsx,
  resolveArchiveLimits,
  validateMappingConfig,
  type ArchiveAuditFields,
  type MappingConfig,
  type MappedRow,
  type ParsedRow,
  type RegimeCatalog,
  type TargetEntity,
  type ValidationError,
  type ValidatorContext,
} from "@ga/import";
import { DocumentsService } from "@ga/storage";

import {
  createPlatformAdminCache,
  requirePlatformAdmin,
  type PlatformAdminContext,
  type SessionDeps,
} from "../auth/platform-admin";
import { buildLoadSession } from "../auth/withRequest";
import {
  runAsTenantOnProductionDb,
  type RequestTenantTx,
} from "../tenant-tx";
import {
  DbLookupAdapter,
  buildTenantCursor,
} from "./imports-adapters";

const {
  documents,
  importJobs,
  importJobRows,
  organizations,
  regimes,
  regimeRtsTemplates,
} = dbSchema;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const DOCUMENT_TYPE_IMPORT_SOURCE = "import_source";

/**
 * Bridge entity vocabularies. Validators key off the singular
 * `TargetEntity` (`maintenance_entry`); the schema and the commit
 * pipeline use the plural `ImportJobTargetTable` (`maintenance_entries`).
 */
function targetTableToEntity(t: ImportJobTargetTable): TargetEntity {
  switch (t) {
    case "aircraft":
      return "aircraft";
    case "maintenance_entries":
      return "maintenance_entry";
    case "components":
      return "component";
    case "flight_time_entries":
      return "flight_time_entry";
  }
}

export interface AdminImportsDeps {
  /** Runtime (`tenant_app`) connection. */
  db: RequestTenantTx extends infer _ ? AdminTenantsDb : never;
  /** Owner-class (`neondb_owner`) BYPASSRLS connection. */
  directDb: AdminTenantsDb;
  /** DocumentsService wired for the production blob driver. */
  documentsService: DocumentsService;
  /** Session HMAC secret. */
  secret: string;
}

// Stand-in alias for the runtime drizzle DB type. The web app uses
// `DocumentsDb` (from @ga/storage) for its postgres-js handle; tests
// pass a pglite-backed drizzle handle. Both expose the same builder
// surface for the queries below.
// eslint-disable-next-line
export type AdminTenantsDb = any;

interface ErrorBody {
  code: string;
  message: string;
  field?: string;
  detail?: unknown;
}

function jsonError(status: number, body: ErrorBody): Response {
  return NextResponse.json(body, { status });
}

/**
 * Response for an XLSX zip-bomb rejection. Wire-tight: the body
 * intentionally omits parser internals, archive filenames, the actor's
 * uploaded filename, and the computed uncompressed sizes. The full
 * audit trail goes to the server-side log only (PMB-193 / PMB-205).
 */
function jsonArchiveRejected(err: XlsxArchiveRejectedError): Response {
  return NextResponse.json(
    {
      error: err.message,
      code: err.code,
      limit_bytes: err.limitBytes,
    },
    { status: err.httpStatus },
  );
}

/**
 * Server-side audit log for archive rejection — never echoed to the
 * client. Lets incident response triage a probing campaign without
 * giving the attacker the exact cap or tuning info.
 */
function logArchiveAudit(args: {
  tenantId: string;
  userId: string;
  requestId: string | null;
  originalFilename: string;
  declaredContentType: string;
  code: string;
  audit: ArchiveAuditFields;
}): void {
  // eslint-disable-next-line no-console
  console.warn("import.xlsx_archive_rejected", {
    tenant_id: args.tenantId,
    user_id: args.userId,
    request_id: args.requestId,
    original_filename: args.originalFilename,
    declared_content_type: args.declaredContentType,
    rejection_code: args.code,
    compressed_archive_bytes: args.audit.compressedArchiveBytes,
    total_uncompressed_bytes: args.audit.totalUncompressedBytes,
    entry_count: args.audit.entryCount,
    largest_entry_uncompressed_bytes: args.audit.largestEntryUncompressedBytes,
    peak_compression_ratio: args.audit.peakCompressionRatio,
  });
}

function looksLikeXlsx(filename: string, contentType: string): boolean {
  return (
    contentType.includes("spreadsheet") ||
    contentType.includes("excel") ||
    filename.toLowerCase().endsWith(".xlsx")
  );
}

async function gate(
  req: Request,
  deps: AdminImportsDeps,
): Promise<PlatformAdminContext | Response> {
  const sessionDeps: SessionDeps = { db: deps.db, secret: deps.secret };
  return requirePlatformAdmin(req, {
    loadSession: buildLoadSession(sessionDeps),
    db: deps.db,
    cache: createPlatformAdminCache(),
  });
}

// ---------------------------------------------------------------------------
// POST /api/admin/imports — multipart upload
// ---------------------------------------------------------------------------

/**
 * Required multipart fields:
 *   - `file`           the spreadsheet (CSV or XLSX)
 *   - `tenant_id`      owning tenant (UUID)
 *   - `target_table`   one of aircraft / maintenance_entries / components / flight_time_entries
 *   - `mapping_config` JSON mapping config (per `@ga/import` schema)
 *
 * Optional:
 *   - `regime_id`      overrides tenant default regime (uncommon)
 *   - `import_kind`    UI hint; defaults to the target_table
 *
 * Creates:
 *   - `documents` row with document_type='import_source' (bytes stored
 *     by the production blob driver, sha256 captured by the
 *     DocumentsService).
 *   - `import_jobs` row in state='pending' with target_table, regime_id,
 *     and mapping_config stamped on it.
 *
 * Returns: `{ importJobId, documentId, state, tenantId, targetTable }`.
 *
 * Tenant scoping: internal admin acts on behalf of `tenant_id` in the
 * body. The route gate enforces platform-admin; the document/job rows
 * are owned by `tenant_id` and isolated by the existing RLS policies.
 */
export async function handleCreateImport(
  req: Request,
  deps: AdminImportsDeps,
): Promise<Response> {
  const ctx = await gate(req, deps);
  if (ctx instanceof Response) return ctx;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError(400, {
      code: "validation_error",
      message: "expected multipart/form-data body",
    });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return jsonError(400, {
      code: "validation_error",
      message: "field `file` is required and must be a file upload",
      field: "file",
    });
  }
  if (file.size === 0) {
    return jsonError(400, {
      code: "validation_error",
      message: "uploaded file is empty",
      field: "file",
    });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return jsonError(413, {
      code: "validation_error",
      message: `file exceeds ${MAX_UPLOAD_BYTES} byte cap`,
      field: "file",
    });
  }

  const tenantId = (form.get("tenant_id") ?? "").toString().trim().toLowerCase();
  if (!UUID_RE.test(tenantId)) {
    return jsonError(400, {
      code: "validation_error",
      message: "field `tenant_id` must be a canonical UUID",
      field: "tenant_id",
    });
  }

  const rawTarget = (form.get("target_table") ?? "").toString().trim();
  if (!isImportTargetTable(rawTarget)) {
    return jsonError(400, {
      code: "validation_error",
      message: `field \`target_table\` must be one of: ${IMPORT_JOB_TARGET_TABLES.join(
        ", ",
      )}`,
      field: "target_table",
    });
  }
  const targetTable: ImportJobTargetTable = rawTarget;

  const rawConfig = (form.get("mapping_config") ?? "").toString();
  if (rawConfig.trim().length === 0) {
    return jsonError(400, {
      code: "validation_error",
      message: "field `mapping_config` is required (JSON)",
      field: "mapping_config",
    });
  }
  let mappingConfig: MappingConfig;
  try {
    mappingConfig = JSON.parse(rawConfig) as MappingConfig;
  } catch {
    return jsonError(400, {
      code: "validation_error",
      message: "field `mapping_config` must be valid JSON",
      field: "mapping_config",
    });
  }
  if (mappingConfig?.targetTable !== targetTable) {
    return jsonError(400, {
      code: "validation_error",
      message:
        "mapping_config.targetTable must match the form `target_table`",
      field: "mapping_config",
    });
  }
  // Structural-only validation at upload — full column-presence check
  // happens at parse time when we know the header row.
  const issuesResult = validateMappingConfig(mappingConfig);
  if (!issuesResult.ok) {
    return jsonError(400, {
      code: "mapping_config_invalid",
      message: `mapping_config has ${issuesResult.issues.length} issue(s)`,
      field: "mapping_config",
      detail: issuesResult.issues,
    });
  }

  // Resolve regime: explicit form field wins; else the tenant default.
  const explicitRegime = (form.get("regime_id") ?? "").toString().trim();
  if (explicitRegime.length > 0 && !UUID_RE.test(explicitRegime)) {
    return jsonError(400, {
      code: "validation_error",
      message: "field `regime_id` must be a canonical UUID",
      field: "regime_id",
    });
  }

  const tenantRow = await deps.directDb
    .select({
      id: organizations.id,
      defaultRegimeId: organizations.defaultRegimeId,
    })
    .from(organizations)
    .where(eq(organizations.id, tenantId))
    .limit(1);
  if (tenantRow.length === 0) {
    return jsonError(404, {
      code: "tenant_not_found",
      message: "tenant_id does not match any organization",
      field: "tenant_id",
    });
  }
  const regimeId =
    explicitRegime.length > 0
      ? explicitRegime
      : (tenantRow[0]!.defaultRegimeId as string | null);
  if (!regimeId) {
    return jsonError(400, {
      code: "validation_error",
      message:
        "tenant has no default_regime_id; supply `regime_id` explicitly",
      field: "regime_id",
    });
  }

  const importKind =
    (form.get("import_kind") ?? "").toString().trim() || targetTable;

  const originalFilename =
    file.name && file.name.length > 0 ? file.name : "import.csv";
  const contentType =
    file.type && file.type.length > 0 ? file.type : guessContentType(originalFilename);
  const body = new Uint8Array(await file.arrayBuffer());

  // PMB-193: zip-bomb pre-flight for XLSX uploads. Walk the central
  // directory and enforce the uncompressed cap BEFORE the file hits
  // storage. First of three concentric checks (upload → parse handler
  // → parser package) so a malicious archive cannot reach ExcelJS via
  // any future caller.
  if (looksLikeXlsx(originalFilename, contentType)) {
    try {
      inspectXlsxArchive(body, resolveArchiveLimits());
    } catch (err) {
      if (err instanceof XlsxArchiveRejectedError) {
        logArchiveAudit({
          tenantId,
          userId: ctx.userId,
          requestId: req.headers.get("x-request-id"),
          originalFilename,
          declaredContentType: contentType,
          code: err.code,
          audit: err.audit,
        });
        return jsonArchiveRejected(err);
      }
      throw err;
    }
  }

  // Upload the source file as a documents row (the DocumentsService
  // computes sha256 + stages the blob and inserts the documents row).
  // The acting user is the admin's session user, not the operator —
  // the audit trail belongs to whoever ran the upload.
  const { document } = await deps.documentsService.upload({
    tenantId,
    documentType: DOCUMENT_TYPE_IMPORT_SOURCE,
    originalFilename,
    contentType,
    body,
    uploadedByUserId: ctx.userId,
  });

  // Insert the import_jobs header in state='pending'. The route stamps
  // tenant_id, target_table, regime_id, mapping_config so parse +
  // commit are deterministic without reading the tenant again.
  const [job] = await deps.directDb
    .insert(importJobs)
    .values({
      tenantId,
      state: "pending" as ImportJobState,
      importKind,
      sourceDocumentId: document.id,
      sourceFilename: originalFilename,
      regimeId,
      targetTable,
      mappingConfig,
      createdByUserId: ctx.userId,
    })
    .returning({ id: importJobs.id });

  return NextResponse.json(
    {
      importJobId: job!.id,
      documentId: document.id,
      state: "pending",
      tenantId,
      targetTable,
      regimeId,
    },
    { status: 201 },
  );
}

function isImportTargetTable(v: string): v is ImportJobTargetTable {
  return (IMPORT_JOB_TARGET_TABLES as readonly string[]).includes(v);
}

function guessContentType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (lower.endsWith(".csv")) return "text/csv";
  return "application/octet-stream";
}

// ---------------------------------------------------------------------------
// POST /api/admin/imports/:id/parse
// ---------------------------------------------------------------------------

/**
 * Drive parser → mapper → validator end to end. State transitions:
 *
 *   pending  → validating → ready    (parser ok; per-row outcomes recorded)
 *   pending  → validating → failed   (parser/structural failure; error_summary set)
 *   failed   → validating → ready / failed (retry; staging rows are wiped first)
 *
 * Row-level validation status is per-row (`valid` / `invalid`). The job
 * state is `ready` whenever the parser+mapping succeeded structurally,
 * even if some rows are invalid; the commit gate (C5) rejects the
 * batch if any row is non-`valid`.
 *
 * Tenant scoping: tenant_id is resolved from the job (admin acting on
 * behalf). All staging writes run inside a tenant-scoped tx so RLS
 * matches.
 */
export async function handleParseImport(
  req: Request,
  context: { params: { id: string } | Promise<{ id: string }> },
  deps: AdminImportsDeps,
): Promise<Response> {
  const ctx = await gate(req, deps);
  if (ctx instanceof Response) return ctx;

  const params = await context.params;
  const importJobId = params.id?.toLowerCase() ?? "";
  if (!UUID_RE.test(importJobId)) {
    return jsonError(400, {
      code: "validation_error",
      message: "path parameter `id` must be a canonical UUID",
      field: "id",
    });
  }

  // Load job header on the direct (BYPASSRLS) connection — admin
  // routes are cross-tenant by design.
  const [job] = await deps.directDb
    .select()
    .from(importJobs)
    .where(eq(importJobs.id, importJobId))
    .limit(1);
  if (!job) {
    return jsonError(404, {
      code: "import_job_not_found",
      message: "import job does not exist",
    });
  }
  if (job.state !== "pending" && job.state !== "failed") {
    return jsonError(409, {
      code: "import_job_not_parsable",
      message: `import job is in state '${job.state}'; only pending or failed jobs may be (re)parsed`,
    });
  }
  if (!job.targetTable || !job.mappingConfig || !job.regimeId) {
    return jsonError(409, {
      code: "import_job_incomplete",
      message:
        "import job is missing target_table / mapping_config / regime_id — was it created via the admin upload route?",
    });
  }
  if (!job.sourceDocumentId) {
    return jsonError(409, {
      code: "import_job_missing_source",
      message: "import job has no source_document_id",
    });
  }

  // Fetch the source bytes. Cross-tenant read is fine; admin scope.
  const { document, body } = await deps.documentsService.retrieve({
    documentId: job.sourceDocumentId as string,
    tenantId: job.tenantId as string,
  });

  // PMB-193: belt-and-suspenders zip-bomb gate. The upload-time gate
  // already inspected this archive, but documents may be re-used by
  // future routes that didn't see the upload check. Re-check at the
  // handler/parser-package seam so the invariant holds.
  if (looksLikeXlsx(document.originalFilename, document.contentType)) {
    try {
      inspectXlsxArchive(body, resolveArchiveLimits());
    } catch (err) {
      if (err instanceof XlsxArchiveRejectedError) {
        logArchiveAudit({
          tenantId: job.tenantId as string,
          userId: ctx.userId,
          requestId: req.headers.get("x-request-id"),
          originalFilename: document.originalFilename,
          declaredContentType: document.contentType,
          code: err.code,
          audit: err.audit,
        });
        await failParse(deps, importJobId, err.code, err.message);
        return jsonArchiveRejected(err);
      }
      throw err;
    }
  }

  // Flip to 'validating' before doing the parse work. If anything below
  // throws, we land 'failed' with a captured cause.
  await deps.directDb
    .update(importJobs)
    .set({ state: "validating", updatedAt: new Date() })
    .where(eq(importJobs.id, importJobId));

  // Wipe any prior staging rows (retry path).
  await deps.directDb
    .delete(importJobRows)
    .where(eq(importJobRows.importJobId, importJobId));

  const mappingConfig = job.mappingConfig as MappingConfig;
  const targetTable = job.targetTable as ImportJobTargetTable;
  const targetEntity = targetTableToEntity(targetTable);
  const tenantId = job.tenantId as string;
  const regimeId = job.regimeId as string;

  let parsedRows: ParsedRow[];
  try {
    parsedRows = await readParsedRows(body, document.contentType, document.originalFilename, mappingConfig);
  } catch (err) {
    await failParse(deps, importJobId, "PARSE_FAILED", (err as Error)?.message ?? String(err));
    return NextResponse.json(
      {
        importJobId,
        state: "failed",
        error: {
          code: "PARSE_FAILED",
          message: (err as Error)?.message ?? String(err),
        },
      },
      { status: 200 },
    );
  }

  // Late-bound column-presence check: the structural schema check ran
  // at upload, but the parser tells us the actual header set now.
  const headerColumns = parsedRows.length > 0 ? Object.keys(parsedRows[0]!.raw_cells) : [];
  const lateResult = validateMappingConfig(mappingConfig, {
    availableColumns: headerColumns,
  });
  if (!lateResult.ok) {
    await failParse(deps, importJobId, "MAPPING_CONFIG_INVALID", "mapping_config does not align with parsed columns", lateResult.issues);
    return NextResponse.json(
      {
        importJobId,
        state: "failed",
        error: {
          code: "MAPPING_CONFIG_INVALID",
          message: "mapping_config does not align with parsed columns",
          detail: lateResult.issues,
        },
      },
      { status: 200 },
    );
  }

  // Run the parse + map + validate pipeline inside a tenant-scoped tx
  // so the mapping engine's lookups and any staging writes go through
  // RLS.
  let validResult: ValidatorContext;
  let totals = { valid: 0, invalid: 0 };
  let firstErrors: { rowNumber: number; field?: string; code: string; message: string }[] = [];

  try {
    await runAsTenantOnProductionDb(
      deps.db,
      tenantId,
      async (tx) => {
        // 1) Map every parsed row → MappedRow.
        const lookups = new DbLookupAdapter(tx);
        const mappedByRow: { parsed: ParsedRow; mapped: MappedRow }[] = [];
        for (const parsed of parsedRows) {
          const mapped = await applyMapping(mappingConfig, parsed, lookups);
          mappedByRow.push({ parsed, mapped });
        }

        // 2) Pre-collect cursor keys, then build the per-batch cursor.
        const aircraftRegistrations = new Set<string>();
        const certificateNumbers = new Set<string>();
        for (const { mapped } of mappedByRow) {
          const reg = mapped.mapped["registration"];
          if (typeof reg === "string" && reg.trim().length > 0) {
            aircraftRegistrations.add(reg);
          }
          const cert = mapped.mapped["signedByCertificateNumber"] ?? mapped.mapped["certificateNumber"];
          if (typeof cert === "string" && cert.trim().length > 0) {
            certificateNumbers.add(cert);
          }
        }
        const cursor = await buildTenantCursor(tx, {
          aircraftRegistrations: Array.from(aircraftRegistrations),
          certificateNumbers: Array.from(certificateNumbers),
        });

        // 3) Build the regime catalog (registration grammar + RTS codes).
        const regimeRow = await tx
          .select({ id: regimes.id, code: regimes.code })
          .from(regimes)
          .where(eq(regimes.id, regimeId))
          .limit(1);
        if (regimeRow.length === 0) {
          throw new Error(`regime ${regimeId} not found`);
        }
        const rtsRows = await tx
          .select({ code: regimeRtsTemplates.code })
          .from(regimeRtsTemplates)
          .where(eq(regimeRtsTemplates.regimeId, regimeId));
        const regime: RegimeCatalog = {
          regimeId,
          code: regimeRow[0]!.code as string,
          registrationRegex:
            (regimeRow[0]!.code as string) === "FAA"
              ? FAA_REGISTRATION_REGEX
              : undefined,
          rts: {
            regimeId,
            codes: new Set(
              (rtsRows as { code: string }[]).map((r) => r.code.toUpperCase()),
            ),
          },
        };

        // 4) Validate row-by-row, sharing batch state across rows.
        const batch = createBatchState();
        const validator = getValidator(targetEntity);
        for (const { parsed, mapped } of mappedByRow) {
          const validatorCtx: ValidatorContext = {
            tenantId,
            regimeId,
            rowNumber: parsed.rowNumber,
            regime,
            cursor,
            batch,
          };
          const result = validator.validate(mapped, validatorCtx);

          // 5) Write the staging row.
          await tx.insert(importJobRows).values({
            tenantId,
            importJobId,
            sourceRowNumber: parsed.rowNumber,
            sourcePayload: parsed.raw_cells,
            mappedPayload: mapped.mapped,
            validationStatus: result.status,
            validationErrors:
              result.status === "invalid"
                ? (result.errors as unknown as Record<string, unknown>)
                : null,
            targetTable,
          });

          if (result.status === "valid") totals.valid++;
          else totals.invalid++;

          if (result.status === "invalid" && firstErrors.length < 50) {
            for (const e of result.errors) {
              if (firstErrors.length >= 50) break;
              firstErrors.push({
                rowNumber: e.rowNumber,
                code: e.code,
                message: e.message,
                field: e.field,
              });
            }
          }
        }

        validResult = { tenantId, regimeId, rowNumber: 0, regime, cursor, batch };
      },
    );
  } catch (err) {
    await failParse(
      deps,
      importJobId,
      "VALIDATE_FAILED",
      (err as Error)?.message ?? String(err),
    );
    return NextResponse.json(
      {
        importJobId,
        state: "failed",
        error: {
          code: "VALIDATE_FAILED",
          message: (err as Error)?.message ?? String(err),
        },
      },
      { status: 200 },
    );
  }

  // Successful parse: state goes to 'ready' even if some rows are invalid.
  await deps.directDb
    .update(importJobs)
    .set({
      state: "ready",
      rowCount: totals.valid + totals.invalid,
      errorSummary: null,
      updatedAt: new Date(),
    })
    .where(eq(importJobs.id, importJobId));

  return NextResponse.json(
    {
      importJobId,
      state: "ready",
      counts: {
        total: totals.valid + totals.invalid,
        valid: totals.valid,
        invalid: totals.invalid,
      },
      errors: firstErrors,
      errorsTruncated: totals.invalid > firstErrors.length,
    },
    { status: 200 },
  );
}

async function failParse(
  deps: AdminImportsDeps,
  importJobId: string,
  code: string,
  message: string,
  detail?: unknown,
): Promise<void> {
  await deps.directDb
    .update(importJobs)
    .set({
      state: "failed",
      errorSummary: { code, message, detail: detail ?? null },
      updatedAt: new Date(),
    })
    .where(eq(importJobs.id, importJobId));
}

async function readParsedRows(
  body: Uint8Array,
  contentType: string,
  filename: string,
  mappingConfig: MappingConfig,
): Promise<ParsedRow[]> {
  const isXlsx =
    contentType.includes("spreadsheet") ||
    contentType.includes("excel") ||
    filename.toLowerCase().endsWith(".xlsx");
  const stream = Readable.from(Buffer.from(body));
  const rows: ParsedRow[] = [];
  if (isXlsx) {
    for await (const row of parseXlsx(stream, {
      sheetName: (mappingConfig as { sheet?: string }).sheet,
    })) {
      rows.push(row);
    }
  } else {
    for await (const row of parseCsv(stream)) {
      rows.push(row);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// POST /api/admin/imports/:id/commit
// ---------------------------------------------------------------------------

/**
 * Invoke the C5 commit pipeline. Idempotent on retry of an already-
 * committed job (the pipeline returns `alreadyCommitted: true`).
 */
export async function handleCommitImport(
  req: Request,
  context: { params: { id: string } | Promise<{ id: string }> },
  deps: AdminImportsDeps,
): Promise<Response> {
  const ctx = await gate(req, deps);
  if (ctx instanceof Response) return ctx;

  const params = await context.params;
  const importJobId = params.id?.toLowerCase() ?? "";
  if (!UUID_RE.test(importJobId)) {
    return jsonError(400, {
      code: "validation_error",
      message: "path parameter `id` must be a canonical UUID",
      field: "id",
    });
  }

  const [job] = await deps.directDb
    .select()
    .from(importJobs)
    .where(eq(importJobs.id, importJobId))
    .limit(1);
  if (!job) {
    return jsonError(404, {
      code: "import_job_not_found",
      message: "import job does not exist",
    });
  }
  if (!job.regimeId) {
    return jsonError(409, {
      code: "import_job_incomplete",
      message: "import job is missing regime_id",
    });
  }

  const service = new IngestionService(deps.db);
  try {
    const result = await service.commitImportJob({
      tenantId: job.tenantId as string,
      userId: ctx.userId,
      regimeId: job.regimeId as string,
      importJobId,
    });
    return NextResponse.json(
      {
        importJobId,
        state: result.state,
        rowsCommitted: result.rowsCommitted,
        alreadyCommitted: result.alreadyCommitted,
      },
      { status: 200 },
    );
  } catch (err) {
    if (err instanceof ImportJobNotCommitableError) {
      return jsonError(409, {
        code: err.code,
        message: err.message,
      });
    }
    if (err instanceof ImportJobHasInvalidRowsError) {
      return jsonError(422, {
        code: err.code,
        message: err.message,
      });
    }
    if (err instanceof ImportJobCommitFailedError) {
      return jsonError(500, {
        code: err.code,
        message: err.message,
      });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// GET /api/admin/imports/:id — status + paginated errors
// ---------------------------------------------------------------------------

const DEFAULT_ERROR_PAGE = 50;
const MAX_ERROR_PAGE = 200;

export async function handleGetImport(
  req: Request,
  context: { params: { id: string } | Promise<{ id: string }> },
  deps: AdminImportsDeps,
): Promise<Response> {
  const ctxGate = await gate(req, deps);
  if (ctxGate instanceof Response) return ctxGate;

  const params = await context.params;
  const importJobId = params.id?.toLowerCase() ?? "";
  if (!UUID_RE.test(importJobId)) {
    return jsonError(400, {
      code: "validation_error",
      message: "path parameter `id` must be a canonical UUID",
      field: "id",
    });
  }

  const [job] = await deps.directDb
    .select()
    .from(importJobs)
    .where(eq(importJobs.id, importJobId))
    .limit(1);
  if (!job) {
    return jsonError(404, {
      code: "import_job_not_found",
      message: "import job does not exist",
    });
  }

  // Pagination parameters
  const url = new URL(req.url);
  const cursorRaw = (url.searchParams.get("error_cursor") ?? "0").trim();
  const limitRaw = (url.searchParams.get("error_limit") ?? "").trim();
  let cursor = Number.parseInt(cursorRaw, 10);
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;
  let limit =
    limitRaw.length > 0 ? Number.parseInt(limitRaw, 10) : DEFAULT_ERROR_PAGE;
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_ERROR_PAGE;
  if (limit > MAX_ERROR_PAGE) limit = MAX_ERROR_PAGE;

  // Counts: query the rows table aggregated by validation_status.
  const counts = await deps.directDb
    .select({
      total: sql<string>`count(*)::text`,
      valid: sql<string>`count(*) filter (where ${importJobRows.validationStatus} = 'valid')::text`,
      invalid: sql<string>`count(*) filter (where ${importJobRows.validationStatus} = 'invalid')::text`,
      committed: sql<string>`count(*) filter (where ${importJobRows.validationStatus} = 'committed')::text`,
    })
    .from(importJobRows)
    .where(eq(importJobRows.importJobId, importJobId));

  const errorRows = await deps.directDb
    .select({
      sourceRowNumber: importJobRows.sourceRowNumber,
      validationErrors: importJobRows.validationErrors,
    })
    .from(importJobRows)
    .where(
      and(
        eq(importJobRows.importJobId, importJobId),
        eq(importJobRows.validationStatus, "invalid"),
        sql`${importJobRows.sourceRowNumber} > ${cursor}`,
      ),
    )
    .orderBy(importJobRows.sourceRowNumber)
    .limit(limit);

  const flat: {
    sourceRowNumber: number;
    code: string;
    message: string;
    field?: string;
  }[] = [];
  for (const r of errorRows as {
    sourceRowNumber: number;
    validationErrors: ValidationError[] | null;
  }[]) {
    if (!r.validationErrors) continue;
    for (const e of r.validationErrors) {
      flat.push({
        sourceRowNumber: r.sourceRowNumber,
        code: e.code,
        message: e.message,
        field: e.field,
      });
    }
  }

  const last = errorRows[errorRows.length - 1] as { sourceRowNumber: number } | undefined;
  const nextCursor = last ? last.sourceRowNumber : null;

  return NextResponse.json(
    {
      importJobId,
      tenantId: job.tenantId,
      state: job.state,
      targetTable: job.targetTable,
      regimeId: job.regimeId,
      sourceFilename: job.sourceFilename,
      rowCount: job.rowCount,
      errorSummary: job.errorSummary,
      counts: {
        total: Number((counts[0] as { total: string } | undefined)?.total ?? "0"),
        valid: Number((counts[0] as { valid: string } | undefined)?.valid ?? "0"),
        invalid: Number(
          (counts[0] as { invalid: string } | undefined)?.invalid ?? "0",
        ),
        committed: Number(
          (counts[0] as { committed: string } | undefined)?.committed ?? "0",
        ),
      },
      errors: flat,
      pagination: {
        cursor,
        limit,
        nextCursor: errorRows.length === limit ? nextCursor : null,
      },
      createdAt: (job.createdAt as Date).toISOString(),
      updatedAt: (job.updatedAt as Date).toISOString(),
      committedAt: job.committedAt
        ? (job.committedAt as Date).toISOString()
        : null,
    },
    { status: 200 },
  );
}
