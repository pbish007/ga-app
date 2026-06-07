"use client";

import Link from "next/link";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { pageShellStyles as s } from "../../../../lib/page-shell";

// ---------------------------------------------------------------------------
// Static catalog — mirrors `@ga/import` TARGET_FIELDS. Inlined here so the
// client bundle does not pull in workspace packages with server-only deps.
// Any change to the source catalog must be mirrored here. The C3 mapping-
// config validator (server-side) is the authoritative gate.
// ---------------------------------------------------------------------------

type ImportTargetTable =
  | "aircraft"
  | "maintenance_entries"
  | "components"
  | "flight_time_entries";

type FieldType =
  | "text"
  | "decimal"
  | "integer"
  | "date"
  | "datetime"
  | "boolean"
  | "uuid"
  | "enum";

interface CatalogField {
  name: string;
  type: FieldType;
  required: boolean;
  enumValues?: readonly string[];
}

const TIME_SOURCES = ["hobbs", "tach"] as const;
const COMPONENT_KINDS = ["engine", "propeller", "appliance"] as const;
const MAINT_ENTRY_TYPES = [
  "maintenance",
  "annual_inspection",
  "100_hour_inspection",
  "inspection_program",
  "ad_compliance",
] as const;

const TARGET_FIELDS: Record<ImportTargetTable, readonly CatalogField[]> = {
  aircraft: [
    { name: "regimeId", type: "uuid", required: true },
    { name: "registration", type: "text", required: true },
    { name: "make", type: "text", required: true },
    { name: "model", type: "text", required: true },
    { name: "serialNumber", type: "text", required: true },
    { name: "yearManufactured", type: "integer", required: false },
    { name: "category", type: "text", required: true },
    { name: "aircraftClass", type: "text", required: true },
    { name: "airframeTotalTime", type: "decimal", required: false },
    {
      name: "timeSource",
      type: "enum",
      required: true,
      enumValues: TIME_SOURCES,
    },
  ],
  maintenance_entries: [
    { name: "aircraftId", type: "uuid", required: true },
    {
      name: "entryType",
      type: "enum",
      required: true,
      enumValues: MAINT_ENTRY_TYPES,
    },
    { name: "workPerformed", type: "text", required: true },
    { name: "performedOn", type: "date", required: true },
    { name: "aircraftTotalTime", type: "decimal", required: true },
    { name: "inspectionProgramId", type: "uuid", required: false },
    { name: "signedAt", type: "datetime", required: false },
    { name: "signedByCertificateNumber", type: "text", required: false },
    { name: "rtsTemplateCode", type: "text", required: false },
  ],
  components: [
    {
      name: "kind",
      type: "enum",
      required: true,
      enumValues: COMPONENT_KINDS,
    },
    { name: "serialNumber", type: "text", required: true },
    { name: "make", type: "text", required: false },
    { name: "model", type: "text", required: false },
    { name: "tboHours", type: "decimal", required: false },
    { name: "tboCalendarMonths", type: "integer", required: false },
    { name: "cycleLimit", type: "integer", required: false },
  ],
  flight_time_entries: [
    { name: "aircraftId", type: "uuid", required: true },
    { name: "airframeTimeNew", type: "decimal", required: true },
    { name: "isOverride", type: "boolean", required: false },
    { name: "overrideReason", type: "text", required: false },
    { name: "enteredAt", type: "datetime", required: false },
  ],
};

const TARGET_TABLE_LABEL: Record<ImportTargetTable, string> = {
  aircraft: "Aircraft",
  maintenance_entries: "Maintenance entries",
  components: "Components",
  flight_time_entries: "Flight-time entries",
};

const LOOKUP_KINDS = [
  "aircraft_by_registration",
  "regime_by_code",
  "component_by_serial",
  "inspection_program_by_code",
] as const;
type LookupKind = (typeof LOOKUP_KINDS)[number];

const LOOKUP_LABEL: Record<LookupKind, string> = {
  aircraft_by_registration: "Aircraft by registration (row cell)",
  regime_by_code: "Regime by code (constant)",
  component_by_serial: "Component by serial number (row cell)",
  inspection_program_by_code: "Inspection program by code (row cell)",
};

const DATE_FORMATS = ["ISO", "MM/DD/YYYY", "DD/MM/YYYY"] as const;
type DateFormat = (typeof DATE_FORMATS)[number];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TenantOption {
  id: string;
  name: string;
  defaultRegimeId: string | null;
}

export interface RegimeOption {
  id: string;
  code: string;
  label: string;
}

interface Props {
  tenants: TenantOption[];
  regimes: RegimeOption[];
}

// ---------------------------------------------------------------------------
// Mapping shapes (wire format → mapping_config JSON)
// ---------------------------------------------------------------------------

type FieldMapKind = "skip" | "column" | "constant" | "lookup";

interface FieldMap {
  kind: FieldMapKind;
  /** column header name (when kind=column or kind=lookup with row-cell source) */
  sourceColumn?: string;
  /** literal value (when kind=constant or kind=lookup with constant source) */
  value?: string;
  /** lookup kind selected */
  lookupKind?: LookupKind;
  /** component_by_serial requires this */
  componentKind?: "engine" | "propeller" | "appliance";
  /** date format override for date-typed columns */
  dateFormat?: DateFormat;
}

interface ImportError {
  code: string;
  message: string;
  field?: string;
}

interface UploadResponse {
  importJobId: string;
}

interface ParseResponse {
  importJobId: string;
  state: "ready" | "failed";
  counts?: { total: number; valid: number; invalid: number };
  errors?: { rowNumber?: number; sourceRowNumber?: number; code: string; message: string; field?: string }[];
  errorsTruncated?: boolean;
  error?: { code: string; message: string; detail?: unknown };
}

interface CommitResponse {
  importJobId: string;
  state: "committed" | "failed";
  rowsCommitted?: number;
  alreadyCommitted?: boolean;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const stepCard: CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: "1rem 1.25rem",
  marginBottom: "1.25rem",
  background: "white",
};

const stepCardActive: CSSProperties = {
  ...stepCard,
  borderColor: "#2563eb",
  boxShadow: "0 1px 2px rgba(37, 99, 235, 0.08)",
};

const stepCardDone: CSSProperties = {
  ...stepCard,
  borderColor: "#10b981",
  background: "#f0fdf4",
};

const stepCardDisabled: CSSProperties = {
  ...stepCard,
  background: "#f9fafb",
  color: "#9ca3af",
};

const stepHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: "0.75rem",
  gap: "0.75rem",
  flexWrap: "wrap",
};

const stepNumber: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  borderRadius: "50%",
  background: "#e5e7eb",
  color: "#374151",
  fontWeight: 700,
  fontSize: "0.9rem",
  flexShrink: 0,
};

const stepTitle: CSSProperties = {
  fontWeight: 600,
  fontSize: "1.05rem",
  margin: 0,
};

const errorBox: CSSProperties = {
  margin: 0,
  color: "#b91c1c",
  background: "#fef2f2",
  padding: "0.65rem 0.85rem",
  borderRadius: 6,
  border: "1px solid #fecaca",
  fontSize: "0.9rem",
};

const successBox: CSSProperties = {
  margin: 0,
  color: "#065f46",
  background: "#ecfdf5",
  padding: "0.65rem 0.85rem",
  borderRadius: 6,
  border: "1px solid #6ee7b7",
  fontSize: "0.9rem",
};

const warningBox: CSSProperties = {
  margin: 0,
  color: "#92400e",
  background: "#fffbeb",
  padding: "0.65rem 0.85rem",
  borderRadius: 6,
  border: "1px solid #fcd34d",
  fontSize: "0.9rem",
};

const monoTd: CSSProperties = {
  ...s.td,
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  fontSize: "0.85rem",
  whiteSpace: "pre-wrap",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ImportWizard({ tenants, regimes }: Props) {
  // ---- step 1: setup --------------------------------------------------------
  const [tenantId, setTenantId] = useState("");
  const [targetTable, setTargetTable] = useState<ImportTargetTable>("aircraft");
  const [regimeOverride, setRegimeOverride] = useState("");
  const [sheetName, setSheetName] = useState("");

  // ---- step 2: file ---------------------------------------------------------
  const [file, setFile] = useState<File | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [sampleRows, setSampleRows] = useState<Record<string, string>[]>([]);
  const [manualColumnsInput, setManualColumnsInput] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);

  // ---- step 3: mapping ------------------------------------------------------
  const [maps, setMaps] = useState<Record<string, FieldMap>>({});

  // ---- step 4/5: server interaction ----------------------------------------
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [createdJobId, setCreatedJobId] = useState<string | null>(null);
  const [parseResult, setParseResult] = useState<ParseResponse | null>(null);
  const [commitResult, setCommitResult] = useState<CommitResponse | null>(null);

  // ---------------------------------------------------------------------------
  // Reset mapping when the target table changes
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const fields = TARGET_FIELDS[targetTable];
    const next: Record<string, FieldMap> = {};
    for (const f of fields) {
      next[f.name] = defaultMapFor(targetTable, f);
    }
    setMaps(next);
  }, [targetTable]);

  // ---------------------------------------------------------------------------
  // File handling — CSV header parse + sample rows for preview
  // ---------------------------------------------------------------------------
  async function handleFile(picked: File | null) {
    setFile(picked);
    setColumns([]);
    setSampleRows([]);
    setFileError(null);
    setParseResult(null);
    setCommitResult(null);
    setCreatedJobId(null);
    if (!picked) return;
    if (picked.size === 0) {
      setFileError("File is empty.");
      return;
    }
    if (picked.size > 25 * 1024 * 1024) {
      setFileError("File exceeds the 25 MB upload cap.");
      return;
    }
    const isXlsx = /\.xlsx$/i.test(picked.name);
    if (isXlsx) {
      // XLSX preview is not done client-side in V1. The server-side C2
      // parser owns XLSX. Operators enter the column headers manually so
      // the mapping step can render.
      return;
    }
    try {
      const text = await picked.slice(0, 256 * 1024).text();
      const parsed = parseCsvBlock(text, 6);
      if (parsed.rows.length === 0) {
        setFileError("Could not read any rows from this CSV.");
        return;
      }
      const headers = parsed.rows[0]!;
      setColumns(headers);
      const sample: Record<string, string>[] = [];
      for (let i = 1; i < parsed.rows.length && sample.length < 5; i++) {
        const row = parsed.rows[i]!;
        const rec: Record<string, string> = {};
        for (let h = 0; h < headers.length; h++) {
          rec[headers[h]!] = row[h] ?? "";
        }
        sample.push(rec);
      }
      setSampleRows(sample);
    } catch (err) {
      setFileError(
        `Could not read the file as CSV: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  function applyManualColumns() {
    const parsed = manualColumnsInput
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (parsed.length === 0) {
      setFileError("Enter at least one column header (comma-separated).");
      return;
    }
    setColumns(parsed);
    setSampleRows([]);
    setFileError(null);
  }

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------
  const tenant = tenants.find((t) => t.id === tenantId) ?? null;
  const isXlsx = file ? /\.xlsx$/i.test(file.name) : false;

  const step1Done =
    tenantId.length > 0 &&
    (TARGET_FIELDS[targetTable] as readonly CatalogField[]).length > 0;

  const step2Done = step1Done && file != null && columns.length > 0;

  // step 3 done iff every required field has a non-skip source
  const fields = TARGET_FIELDS[targetTable];
  const mappingIncomplete = fields
    .filter((f) => f.required)
    .filter((f) => {
      const m = maps[f.name];
      if (!m || m.kind === "skip") return true;
      if (m.kind === "column" && !m.sourceColumn) return true;
      if (m.kind === "constant" && (m.value == null || m.value.length === 0))
        return true;
      if (m.kind === "lookup") {
        if (!m.lookupKind) return true;
        if (m.lookupKind === "regime_by_code") {
          if (!m.value || m.value.length === 0) return true;
        } else {
          if (!m.sourceColumn) return true;
        }
        if (m.lookupKind === "component_by_serial" && !m.componentKind) {
          return true;
        }
      }
      return false;
    });
  const step3Done = step2Done && mappingIncomplete.length === 0;

  // ---------------------------------------------------------------------------
  // Server actions
  // ---------------------------------------------------------------------------
  async function uploadAndParse() {
    if (!file || !step3Done) return;
    setSubmitting(true);
    setServerError(null);
    setParseResult(null);
    setCommitResult(null);
    setCreatedJobId(null);
    try {
      const mappingConfig = buildMappingConfig(targetTable, maps, sheetName);
      const fd = new FormData();
      fd.append("file", file);
      fd.append("tenant_id", tenantId);
      fd.append("target_table", targetTable);
      fd.append("mapping_config", JSON.stringify(mappingConfig));
      if (regimeOverride.length > 0) fd.append("regime_id", regimeOverride);

      const uploadRes = await fetch("/api/admin/imports", {
        method: "POST",
        body: fd,
      });
      const uploadBody = (await uploadRes
        .json()
        .catch(() => ({}))) as Partial<UploadResponse> & Partial<ImportError>;
      if (!uploadRes.ok) {
        const detail = (uploadBody as { detail?: unknown }).detail;
        const detailNote =
          detail && Array.isArray(detail) && detail.length > 0
            ? ` (${(detail as { code?: string; message?: string }[])
                .map((d) => d.code ?? d.message ?? "?")
                .join("; ")})`
            : "";
        setServerError(
          `Upload failed (${uploadRes.status}): ${
            uploadBody.message ?? "unknown error"
          }${detailNote}`,
        );
        setSubmitting(false);
        return;
      }
      const jobId = uploadBody.importJobId;
      if (!jobId) {
        setServerError("Upload succeeded but no importJobId was returned.");
        setSubmitting(false);
        return;
      }
      setCreatedJobId(jobId);

      const parseRes = await fetch(`/api/admin/imports/${jobId}/parse`, {
        method: "POST",
      });
      const parseBody = (await parseRes.json().catch(() => ({}))) as ParseResponse &
        Partial<ImportError>;
      if (!parseRes.ok) {
        setServerError(
          `Parse failed (${parseRes.status}): ${
            (parseBody as { message?: string }).message ?? "unknown error"
          }`,
        );
        setSubmitting(false);
        return;
      }
      setParseResult(parseBody);
    } catch (err) {
      setServerError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function commit() {
    if (!createdJobId) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const res = await fetch(`/api/admin/imports/${createdJobId}/commit`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as CommitResponse &
        Partial<ImportError>;
      if (!res.ok) {
        setServerError(
          `Commit failed (${res.status}): ${
            (body as { message?: string }).message ?? "unknown error"
          }`,
        );
        setSubmitting(false);
        return;
      }
      setCommitResult(body);
    } catch (err) {
      setServerError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSubmitting(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const validCount = parseResult?.counts?.valid ?? 0;
  const invalidCount = parseResult?.counts?.invalid ?? 0;
  const totalCount = parseResult?.counts?.total ?? 0;
  const canCommit =
    !!parseResult &&
    parseResult.state === "ready" &&
    invalidCount === 0 &&
    totalCount > 0 &&
    !commitResult;

  return (
    <section style={{ marginTop: "1rem" }}>
      <StepCard
        n={1}
        title="Set up the job"
        status={step1Done ? "done" : "active"}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "1rem",
          }}
        >
          <label style={s.field}>
            <span style={s.label}>Tenant</span>
            <select
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              style={s.select}
              required
            >
              <option value="">Pick a tenant…</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label style={s.field}>
            <span style={s.label}>Target table</span>
            <select
              value={targetTable}
              onChange={(e) =>
                setTargetTable(e.target.value as ImportTargetTable)
              }
              style={s.select}
            >
              {(Object.keys(TARGET_FIELDS) as ImportTargetTable[]).map((t) => (
                <option key={t} value={t}>
                  {TARGET_TABLE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "1rem",
            marginTop: "0.75rem",
          }}
        >
          <label style={s.field}>
            <span style={s.label}>Regime override (optional)</span>
            <select
              value={regimeOverride}
              onChange={(e) => setRegimeOverride(e.target.value)}
              style={s.select}
            >
              <option value="">Use tenant default</option>
              {regimes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
            {tenant && (
              <span style={{ fontSize: "0.8rem", color: "#666" }}>
                Tenant default:{" "}
                {tenant.defaultRegimeId
                  ? regimes.find((r) => r.id === tenant.defaultRegimeId)
                      ?.label ?? tenant.defaultRegimeId
                  : "none set"}
              </span>
            )}
          </label>
          <label style={s.field}>
            <span style={s.label}>Sheet name (XLSX only)</span>
            <input
              type="text"
              value={sheetName}
              onChange={(e) => setSheetName(e.target.value)}
              placeholder="leave blank for first sheet"
              style={s.input}
            />
          </label>
        </div>
      </StepCard>

      <StepCard
        n={2}
        title="Choose the file"
        status={
          !step1Done ? "disabled" : step2Done ? "done" : "active"
        }
      >
        <input
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
          disabled={!step1Done}
          aria-label="Spreadsheet file"
          style={{ marginBottom: "0.5rem" }}
        />
        {file && (
          <p style={{ ...s.muted, fontSize: "0.9rem" }}>
            <strong>{file.name}</strong> — {formatBytes(file.size)}
          </p>
        )}
        {isXlsx && columns.length === 0 && (
          <div style={warningBox}>
            <p style={{ margin: 0 }}>
              <strong>XLSX preview not available in the browser.</strong> Enter
              the column header row below, comma-separated, to continue. The
              server-side parser still reads the file as-is at parse time.
            </p>
            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                marginTop: "0.5rem",
                flexWrap: "wrap",
              }}
            >
              <input
                type="text"
                value={manualColumnsInput}
                onChange={(e) => setManualColumnsInput(e.target.value)}
                placeholder="Tail #, Date, Description, TT"
                style={{ ...s.input, maxWidth: 500 }}
              />
              <button
                type="button"
                onClick={applyManualColumns}
                style={s.button}
              >
                Use columns
              </button>
            </div>
          </div>
        )}
        {fileError && (
          <p role="alert" style={errorBox}>
            {fileError}
          </p>
        )}
        {columns.length > 0 && (
          <p style={{ ...s.muted, fontSize: "0.9rem" }}>
            {columns.length} column
            {columns.length === 1 ? "" : "s"} detected
            {sampleRows.length > 0
              ? ` — previewing first ${sampleRows.length} data row(s).`
              : "."}
          </p>
        )}
        {sampleRows.length > 0 && (
          <div style={{ ...s.tableWrap, marginTop: "0.5rem" }}>
            <table style={s.table}>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c} style={s.th}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sampleRows.map((r, i) => (
                  <tr key={i}>
                    {columns.map((c) => (
                      <td key={c} style={monoTd}>
                        {r[c] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </StepCard>

      <StepCard
        n={3}
        title="Map columns to fields"
        status={
          !step2Done ? "disabled" : step3Done ? "done" : "active"
        }
      >
        {!step2Done ? null : (
          <>
            <p style={{ ...s.muted, fontSize: "0.9rem", marginTop: 0 }}>
              For each target field, pick a source. Required fields are marked.
              UUID fields almost always use a lookup.
            </p>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.75rem",
              }}
            >
              {fields.map((f) => (
                <FieldMapRow
                  key={f.name}
                  field={f}
                  value={maps[f.name] ?? { kind: "skip" }}
                  columns={columns}
                  onChange={(next) =>
                    setMaps((prev) => ({ ...prev, [f.name]: next }))
                  }
                />
              ))}
            </div>
            {sampleRows.length > 0 && step3Done && (
              <details
                style={{
                  marginTop: "1rem",
                  border: "1px solid #e5e7eb",
                  borderRadius: 6,
                  padding: "0.5rem 0.85rem",
                }}
              >
                <summary
                  style={{
                    cursor: "pointer",
                    fontWeight: 600,
                  }}
                >
                  Preview mapped values (first {sampleRows.length} row
                  {sampleRows.length === 1 ? "" : "s"})
                </summary>
                <MappingPreview
                  sampleRows={sampleRows}
                  fields={fields}
                  maps={maps}
                />
              </details>
            )}
          </>
        )}
      </StepCard>

      <StepCard
        n={4}
        title="Validate"
        status={
          !step3Done
            ? "disabled"
            : parseResult?.state === "ready" && invalidCount === 0
              ? "done"
              : "active"
        }
      >
        {!step3Done ? null : (
          <>
            <div
              style={{
                display: "flex",
                gap: "0.75rem",
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                onClick={uploadAndParse}
                disabled={submitting || (parseResult?.state === "ready" && invalidCount === 0)}
                style={{
                  ...s.button,
                  background:
                    submitting || (parseResult?.state === "ready" && invalidCount === 0)
                      ? "#9db8f0"
                      : "#2563eb",
                  cursor:
                    submitting || (parseResult?.state === "ready" && invalidCount === 0)
                      ? "not-allowed"
                      : "pointer",
                }}
              >
                {submitting && !commitResult
                  ? "Uploading…"
                  : parseResult
                    ? "Re-validate"
                    : "Upload & validate"}
              </button>
              {createdJobId && (
                <Link
                  href={`/admin/imports/${createdJobId}`}
                  style={s.link}
                  target="_blank"
                >
                  Open job page ↗
                </Link>
              )}
            </div>
            {serverError && (
              <p role="alert" style={{ ...errorBox, marginTop: "0.75rem" }}>
                {serverError}
              </p>
            )}
            {parseResult && (
              <div style={{ marginTop: "0.75rem" }}>
                {parseResult.state === "failed" ? (
                  <p style={errorBox}>
                    <strong>Parse failed.</strong>{" "}
                    {parseResult.error?.code ?? "PARSE_FAILED"}:{" "}
                    {parseResult.error?.message ?? "no detail"}
                  </p>
                ) : (
                  <>
                    <p
                      role="status"
                      style={
                        invalidCount === 0 && totalCount > 0
                          ? successBox
                          : warningBox
                      }
                    >
                      Parsed <strong>{totalCount}</strong> row(s) —{" "}
                      <strong>{validCount}</strong> valid,{" "}
                      <strong>{invalidCount}</strong> invalid.
                    </p>
                    {parseResult.errors && parseResult.errors.length > 0 && (
                      <div
                        style={{ ...s.tableWrap, marginTop: "0.5rem" }}
                        aria-label="Validation errors"
                      >
                        <table style={s.table}>
                          <thead>
                            <tr>
                              <th style={s.th}>Row</th>
                              <th style={s.th}>Field</th>
                              <th style={s.th}>Code</th>
                              <th style={s.th}>Message</th>
                            </tr>
                          </thead>
                          <tbody>
                            {parseResult.errors.map((e, i) => (
                              <tr key={i}>
                                <td style={s.td}>
                                  {e.sourceRowNumber ?? e.rowNumber ?? "—"}
                                </td>
                                <td style={s.td}>{e.field ?? "—"}</td>
                                <td style={s.td}>
                                  <code>{e.code}</code>
                                </td>
                                <td style={s.td}>{e.message}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {parseResult.errorsTruncated && (
                          <p style={{ ...s.muted, padding: "0.5rem" }}>
                            Showing first {parseResult.errors.length} errors —
                            open the job page for the full paginated list.
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </StepCard>

      <StepCard
        n={5}
        title="Commit"
        status={
          commitResult?.state === "committed"
            ? "done"
            : canCommit
              ? "active"
              : "disabled"
        }
      >
        {commitResult ? (
          commitResult.state === "committed" ? (
            <div style={{ ...successBox, padding: "1rem" }}>
              <p style={{ margin: 0 }}>
                <strong>Committed.</strong>{" "}
                {commitResult.rowsCommitted ?? 0} row(s) written.
                {commitResult.alreadyCommitted
                  ? " (idempotent retry — no new writes)"
                  : ""}
              </p>
              {createdJobId && (
                <p style={{ margin: "0.5rem 0 0", fontSize: "0.85rem" }}>
                  Job:{" "}
                  <Link
                    href={`/admin/imports/${createdJobId}`}
                    style={{ color: "#065f46" }}
                  >
                    {createdJobId}
                  </Link>
                </p>
              )}
            </div>
          ) : (
            <p style={errorBox}>
              <strong>Commit failed.</strong> Re-run the validation step or open
              the job page for detail.
            </p>
          )
        ) : (
          <>
            <p style={{ ...s.muted, fontSize: "0.9rem", marginTop: 0 }}>
              Enabled when all rows are valid. Commit is transactional and
              idempotent on retry.
            </p>
            <button
              type="button"
              onClick={commit}
              disabled={!canCommit || submitting}
              style={{
                ...s.button,
                background:
                  !canCommit || submitting ? "#9db8f0" : "#059669",
                cursor: !canCommit || submitting ? "not-allowed" : "pointer",
              }}
            >
              {submitting ? "Committing…" : "Commit import"}
            </button>
          </>
        )}
      </StepCard>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function StepCard(props: {
  n: number;
  title: string;
  status: "active" | "done" | "disabled";
  children: ReactNode;
}) {
  const style =
    props.status === "done"
      ? stepCardDone
      : props.status === "active"
        ? stepCardActive
        : stepCardDisabled;
  return (
    <section style={style} aria-disabled={props.status === "disabled"}>
      <header style={stepHeader}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <span
            style={{
              ...stepNumber,
              background:
                props.status === "done"
                  ? "#10b981"
                  : props.status === "active"
                    ? "#2563eb"
                    : "#e5e7eb",
              color:
                props.status === "done" || props.status === "active"
                  ? "white"
                  : "#374151",
            }}
            aria-hidden
          >
            {props.status === "done" ? "✓" : props.n}
          </span>
          <h2 style={stepTitle}>{props.title}</h2>
        </div>
      </header>
      {props.children}
    </section>
  );
}

function FieldMapRow(props: {
  field: CatalogField;
  value: FieldMap;
  columns: string[];
  onChange: (next: FieldMap) => void;
}) {
  const { field, value, columns, onChange } = props;
  const isUuid = field.type === "uuid";

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(160px, 1fr) 1fr 2fr",
        gap: "0.5rem",
        alignItems: "start",
        borderBottom: "1px solid #f3f4f6",
        paddingBottom: "0.5rem",
      }}
    >
      <div>
        <div style={{ fontWeight: 600 }}>
          {field.name}
          {field.required && (
            <span style={{ color: "#dc2626", marginLeft: "0.25rem" }}>*</span>
          )}
        </div>
        <div style={{ fontSize: "0.8rem", color: "#666" }}>
          {field.type}
          {field.enumValues ? `: ${field.enumValues.join(" | ")}` : ""}
        </div>
      </div>
      <select
        value={value.kind}
        onChange={(e) => {
          const k = e.target.value as FieldMapKind;
          // reset other fields when switching kind
          onChange({
            kind: k,
            sourceColumn:
              k === "column" || k === "lookup" ? value.sourceColumn : undefined,
            value:
              k === "constant" ||
              (k === "lookup" && value.lookupKind === "regime_by_code")
                ? value.value
                : undefined,
            lookupKind: k === "lookup" ? value.lookupKind : undefined,
            componentKind:
              k === "lookup" && value.lookupKind === "component_by_serial"
                ? value.componentKind
                : undefined,
            dateFormat: k === "column" ? value.dateFormat : undefined,
          });
        }}
        style={s.select}
        aria-label={`Source kind for ${field.name}`}
      >
        {!field.required && <option value="skip">Skip (leave empty)</option>}
        <option value="column">From column</option>
        <option value="constant">Constant value</option>
        <option value="lookup">Lookup</option>
      </select>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.35rem",
        }}
      >
        {value.kind === "column" && (
          <>
            <select
              value={value.sourceColumn ?? ""}
              onChange={(e) =>
                onChange({ ...value, sourceColumn: e.target.value })
              }
              style={s.select}
              aria-label={`Source column for ${field.name}`}
            >
              <option value="">Pick a column…</option>
              {columns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            {field.type === "date" && (
              <select
                value={value.dateFormat ?? "ISO"}
                onChange={(e) =>
                  onChange({
                    ...value,
                    dateFormat: e.target.value as DateFormat,
                  })
                }
                style={s.select}
                aria-label={`Date format for ${field.name}`}
              >
                {DATE_FORMATS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            )}
          </>
        )}
        {value.kind === "constant" && (
          <input
            type="text"
            value={value.value ?? ""}
            onChange={(e) => onChange({ ...value, value: e.target.value })}
            placeholder={
              field.enumValues
                ? field.enumValues.join(" | ")
                : `constant ${field.type} value`
            }
            style={s.input}
            aria-label={`Constant value for ${field.name}`}
          />
        )}
        {value.kind === "lookup" && (
          <>
            <select
              value={value.lookupKind ?? ""}
              onChange={(e) =>
                onChange({
                  ...value,
                  lookupKind: e.target.value as LookupKind,
                  // reset peer fields
                  value:
                    e.target.value === "regime_by_code"
                      ? value.value
                      : undefined,
                  sourceColumn:
                    e.target.value !== "regime_by_code"
                      ? value.sourceColumn
                      : undefined,
                })
              }
              style={s.select}
              aria-label={`Lookup kind for ${field.name}`}
            >
              <option value="">Pick a lookup…</option>
              {LOOKUP_KINDS.map((k) => (
                <option key={k} value={k}>
                  {LOOKUP_LABEL[k]}
                </option>
              ))}
            </select>
            {value.lookupKind === "regime_by_code" && (
              <input
                type="text"
                value={value.value ?? ""}
                onChange={(e) =>
                  onChange({ ...value, value: e.target.value })
                }
                placeholder="e.g. FAA"
                style={s.input}
                aria-label="Regime code value"
              />
            )}
            {value.lookupKind && value.lookupKind !== "regime_by_code" && (
              <select
                value={value.sourceColumn ?? ""}
                onChange={(e) =>
                  onChange({ ...value, sourceColumn: e.target.value })
                }
                style={s.select}
                aria-label={`Lookup source column for ${field.name}`}
              >
                <option value="">Pick a column…</option>
                {columns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
            {value.lookupKind === "component_by_serial" && (
              <select
                value={value.componentKind ?? ""}
                onChange={(e) =>
                  onChange({
                    ...value,
                    componentKind: e.target.value as
                      | "engine"
                      | "propeller"
                      | "appliance",
                  })
                }
                style={s.select}
                aria-label={`Component kind for ${field.name}`}
              >
                <option value="">Pick a kind…</option>
                {COMPONENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            )}
          </>
        )}
        {!isUuid && field.required && value.kind === "skip" && (
          <span style={{ fontSize: "0.8rem", color: "#dc2626" }}>
            Required field — pick a source.
          </span>
        )}
      </div>
    </div>
  );
}

function MappingPreview(props: {
  sampleRows: Record<string, string>[];
  fields: readonly CatalogField[];
  maps: Record<string, FieldMap>;
}) {
  const { sampleRows, fields, maps } = props;
  const mappedFields = fields.filter((f) => maps[f.name]?.kind !== "skip");
  return (
    <div style={{ ...s.tableWrap, marginTop: "0.5rem" }}>
      <table style={s.table}>
        <thead>
          <tr>
            <th style={s.th}>Row</th>
            {mappedFields.map((f) => (
              <th key={f.name} style={s.th}>
                {f.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sampleRows.map((r, i) => (
            <tr key={i}>
              <td style={s.td}>{i + 2}</td>
              {mappedFields.map((f) => {
                const m = maps[f.name]!;
                const v = previewValueFor(m, r);
                return (
                  <td key={f.name} style={monoTd}>
                    {v}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function previewValueFor(m: FieldMap, row: Record<string, string>): string {
  if (m.kind === "constant") return m.value ?? "";
  if (m.kind === "column") return row[m.sourceColumn ?? ""] ?? "";
  if (m.kind === "lookup") {
    if (m.lookupKind === "regime_by_code") return `→ regime(${m.value ?? "?"})`;
    if (m.sourceColumn) {
      const raw = row[m.sourceColumn] ?? "";
      return raw ? `→ ${m.lookupKind}(${raw})` : "(empty key)";
    }
    return "(lookup unconfigured)";
  }
  return "";
}

function defaultMapFor(table: ImportTargetTable, f: CatalogField): FieldMap {
  if (f.type === "uuid") {
    if (f.name === "regimeId") {
      return {
        kind: "lookup",
        lookupKind: "regime_by_code",
        value: "FAA",
      };
    }
    if (f.name === "aircraftId") {
      return {
        kind: "lookup",
        lookupKind: "aircraft_by_registration",
      };
    }
    if (f.name === "inspectionProgramId") {
      return {
        kind: f.required ? "lookup" : "skip",
        lookupKind: "inspection_program_by_code",
      };
    }
    return { kind: f.required ? "lookup" : "skip" };
  }
  return { kind: f.required ? "column" : "skip" };
}

function buildMappingConfig(
  table: ImportTargetTable,
  maps: Record<string, FieldMap>,
  sheet: string,
): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  const constants: Record<string, unknown> = {};
  const lookups: Record<string, unknown>[] = [];
  for (const [fieldName, m] of Object.entries(maps)) {
    if (m.kind === "skip") continue;
    if (m.kind === "column" && m.sourceColumn) {
      const entry: Record<string, unknown> = { source: m.sourceColumn };
      const f = TARGET_FIELDS[table].find((x) => x.name === fieldName);
      if (f?.type === "date") {
        entry.format = { kind: "date", format: m.dateFormat ?? "ISO" };
      }
      columns[fieldName] = entry;
    } else if (m.kind === "constant") {
      const f = TARGET_FIELDS[table].find((x) => x.name === fieldName);
      constants[fieldName] = coerceConstant(m.value ?? "", f?.type ?? "text");
    } else if (m.kind === "lookup" && m.lookupKind) {
      const entry: Record<string, unknown> = {
        kind: m.lookupKind,
        target: fieldName,
      };
      if (m.lookupKind === "regime_by_code") {
        entry.value = m.value ?? "";
      } else {
        entry.sourceColumn = m.sourceColumn ?? "";
      }
      if (m.lookupKind === "component_by_serial" && m.componentKind) {
        entry.componentKind = m.componentKind;
      }
      lookups.push(entry);
    }
  }
  const cfg: Record<string, unknown> = {
    version: "1",
    targetTable: table,
  };
  if (sheet.trim().length > 0) cfg.sheet = sheet.trim();
  if (Object.keys(columns).length > 0) cfg.columns = columns;
  if (Object.keys(constants).length > 0) cfg.constants = constants;
  if (lookups.length > 0) cfg.lookups = lookups;
  return cfg;
}

function coerceConstant(raw: string, type: FieldType): unknown {
  switch (type) {
    case "decimal":
    case "integer": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    case "boolean": {
      const lower = raw.toLowerCase();
      if (["true", "yes", "y", "1"].includes(lower)) return true;
      if (["false", "no", "n", "0", ""].includes(lower)) return false;
      return raw;
    }
    default:
      return raw;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Lightweight CSV reader: returns up to `maxRows` rows from a UTF-8 text
 * block. Supports double-quoted cells with escaped quotes and embedded
 * commas. Trims trailing CR. Strips a leading BOM from the first cell of
 * the first row.
 */
function parseCsvBlock(
  text: string,
  maxRows: number,
): { rows: string[][] } {
  const rows: string[][] = [];
  let cur = "";
  let row: string[] = [];
  let quoted = false;
  let i = 0;
  const flushCell = () => {
    row.push(cur);
    cur = "";
  };
  const flushRow = () => {
    flushCell();
    rows.push(row);
    row = [];
  };
  while (i < text.length && rows.length < maxRows) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (ch === ",") {
      flushCell();
      i++;
      continue;
    }
    if (ch === "\n") {
      flushRow();
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (rows.length < maxRows && (cur.length > 0 || row.length > 0)) {
    flushRow();
  }
  if (rows.length > 0 && rows[0]!.length > 0) {
    const first = rows[0]![0]!;
    if (first.charCodeAt(0) === 0xfeff) rows[0]![0] = first.slice(1);
  }
  return { rows };
}
