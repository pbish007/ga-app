import {
  AIRCRAFT_TIME_SOURCES,
  COMPONENT_KINDS,
  IMPORT_JOB_TARGET_TABLES,
  MAINTENANCE_ENTRY_TYPES,
  type ImportJobTargetTable,
} from "@ga/db";

export { IMPORT_JOB_TARGET_TABLES };
export type { ImportJobTargetTable };

/**
 * Closed vocabulary of value kinds the mapping engine knows how to
 * materialize into `mapped_payload`. Each kind names how column-format
 * coercion produces it from a parser cell and what JSON shape the
 * commit pipeline (PMB-161 / C5) expects to read back.
 *
 *   text     — plain string. Source coerced via `String(raw).trim()`.
 *   decimal  — JS number; serializes to JSON as a number. The C5
 *              writer hands it to Drizzle's numeric() column unchanged.
 *   integer  — JS number constrained to integer values.
 *   date     — ISO-8601 calendar date string `YYYY-MM-DD`. Matches the
 *              `date` PG column kind used by maintenance_entries.performed_on.
 *   datetime — ISO-8601 timestamp string. Matches `timestamptz` columns
 *              the importer populates (e.g. flight_time_entries.entered_at).
 *   boolean  — JS boolean.
 *   enum     — string from a closed `values` list. Used for things like
 *              aircraft.time_source or component.kind.
 *   uuid     — UUID string. Typically populated by a lookup (e.g.
 *              aircraftId resolved from a tail number), but a column or
 *              constant carrying a UUID is also accepted.
 */
export type TargetFieldType =
  | { kind: "text" }
  | { kind: "decimal" }
  | { kind: "integer" }
  | { kind: "date" }
  | { kind: "datetime" }
  | { kind: "boolean" }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "uuid" };

/**
 * Catalog entry for one mappable target field on a V1 target table.
 *
 * `required` mirrors the DB nullability invariant. A mapping config
 * that does not provide a source for a required field is rejected by
 * the validator; the per-entity validator (PMB-160 / C4) re-checks at
 * runtime in case a row has an empty source cell.
 *
 * `defaultsToNull` flags optional fields whose absence from
 * mapping_config is the normal case and not surprising — primarily
 * the importer-NULL traceability hook, sign-off half of a maintenance
 * entry, and similar columns the operator never touches at backfill.
 * The catalog still lists them so a mapping_config that explicitly
 * names them can populate them.
 */
export interface TargetField {
  name: string;
  type: TargetFieldType;
  required: boolean;
  defaultsToNull?: boolean;
}

/**
 * Per-target-table list of fields the V1 importer is allowed to map
 * via a `mapping_config`. Anything not listed here is rejected as an
 * "unknown target field" by `validateMappingConfig`.
 *
 * Columns deliberately excluded because the commit pipeline owns them:
 *   - `id` (defaultRandom)
 *   - `tenantId` (taken from import_jobs.tenant_id at commit time)
 *   - `createdAt` / `updatedAt` (DB defaults)
 *   - `sourceImportRowId` (commit pipeline sets to the staging row id)
 *
 * Columns deliberately excluded because they belong to a later flow:
 *   - maintenance_entries sign-off half (signed_at, signed_by_*,
 *     rts_*, signed_by_certificate_number) — backfilled maintenance
 *     rows land unsigned; the sign() flow (Epic F) is interactive.
 *   - maintenance_entries.correction_of_id — corrections are a
 *     future-row workflow, not a backfill shape.
 */
export const TARGET_FIELDS: Record<
  ImportJobTargetTable,
  readonly TargetField[]
> = {
  aircraft: [
    { name: "regimeId", type: { kind: "uuid" }, required: true },
    { name: "registration", type: { kind: "text" }, required: true },
    { name: "make", type: { kind: "text" }, required: true },
    { name: "model", type: { kind: "text" }, required: true },
    { name: "serialNumber", type: { kind: "text" }, required: true },
    {
      name: "yearManufactured",
      type: { kind: "integer" },
      required: false,
    },
    { name: "category", type: { kind: "text" }, required: true },
    { name: "aircraftClass", type: { kind: "text" }, required: true },
    {
      name: "airframeTotalTime",
      type: { kind: "decimal" },
      required: false,
    },
    {
      name: "timeSource",
      type: { kind: "enum", values: AIRCRAFT_TIME_SOURCES },
      required: true,
    },
  ],

  maintenance_entries: [
    { name: "aircraftId", type: { kind: "uuid" }, required: true },
    {
      name: "entryType",
      type: { kind: "enum", values: MAINTENANCE_ENTRY_TYPES },
      required: true,
    },
    { name: "workPerformed", type: { kind: "text" }, required: true },
    { name: "performedOn", type: { kind: "date" }, required: true },
    {
      name: "aircraftTotalTime",
      type: { kind: "decimal" },
      required: true,
    },
    {
      name: "inspectionProgramId",
      type: { kind: "uuid" },
      required: false,
      defaultsToNull: true,
    },
  ],

  components: [
    {
      name: "kind",
      type: { kind: "enum", values: COMPONENT_KINDS },
      required: true,
    },
    { name: "serialNumber", type: { kind: "text" }, required: true },
    { name: "make", type: { kind: "text" }, required: false },
    { name: "model", type: { kind: "text" }, required: false },
    { name: "tboHours", type: { kind: "decimal" }, required: false },
    {
      name: "tboCalendarMonths",
      type: { kind: "integer" },
      required: false,
    },
    { name: "cycleLimit", type: { kind: "integer" }, required: false },
  ],

  flight_time_entries: [
    { name: "aircraftId", type: { kind: "uuid" }, required: true },
    {
      name: "airframeTimeNew",
      type: { kind: "decimal" },
      required: true,
    },
    { name: "isOverride", type: { kind: "boolean" }, required: false },
    { name: "overrideReason", type: { kind: "text" }, required: false },
    {
      name: "enteredAt",
      type: { kind: "datetime" },
      required: false,
      defaultsToNull: true,
    },
  ],
};

export function targetFieldsFor(
  table: ImportJobTargetTable,
): readonly TargetField[] {
  return TARGET_FIELDS[table];
}

export function findTargetField(
  table: ImportJobTargetTable,
  name: string,
): TargetField | undefined {
  return TARGET_FIELDS[table].find((f) => f.name === name);
}
