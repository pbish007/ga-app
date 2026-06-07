# Importer `mapping_config` (V1)

The V1 spreadsheet/paper importer (PMB-95) routes operator uploads through a four-stage pipeline:

```
upload → parse (C2) → map (C3) → validate (C4) → commit (C5)
```

The **mapping** stage takes the parser's normalized cell matrix and a **`mapping_config` JSON** and produces a `mapped_payload` per row keyed by target-entity field names. This page is the authoritative reference for that JSON shape — the source of truth for the **importer UI**, **external integrations**, and **internal callers** that hand-author saved templates.

The runtime types and validator live in `@ga/import`:

- `MappingConfig` — TypeScript shape.
- `MAPPING_CONFIG_JSON_SCHEMA` — JSON Schema (draft 2020-12) for structural validation.
- `validateMappingConfig(cfg, { availableColumns? })` — semantic validation; returns `MappingConfigIssue[]`.
- `applyMapping(cfg, parsedRow, lookupAdapter)` — produces `MappedRow`.

## Top-level shape

```jsonc
{
  "version": "1",
  "targetTable": "aircraft" | "maintenance_entries" | "components" | "flight_time_entries",
  "sheet": "Sheet1",                  // optional XLSX worksheet name
  "columns":   { ... },               // direct cell → field
  "constants": { ... },               // literal value → field
  "lookups":   [ ... ]                // tenant-scoped id resolution → field
}
```

| Field         | Required | Notes                                                                                            |
| ------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `version`     | yes      | Always `"1"` today. Bumping is a versioning event tied to a follow-up issue.                     |
| `targetTable` | yes      | One of the four V1 live tables. Anything else is rejected (`UNKNOWN_TARGET_TABLE`).              |
| `sheet`       | no       | XLSX worksheet name. Parser uses the first sheet by default.                                     |
| `columns`     | no       | Map of **target field** → column mapping. May be omitted when every target field comes elsewhere. |
| `constants`   | no       | Map of **target field** → literal value (string \| number \| boolean \| null).                    |
| `lookups`     | no       | Array of tenant-scoped id resolutions.                                                           |

### Sourcing rules

- Every **required** target field MUST be sourced by exactly **one** of `columns`, `constants`, `lookups`.
- A target field that appears in more than one section is rejected (`DUPLICATE_TARGET_FIELD`) — the operator must pick a single shape per field.
- **Optional** target fields can be omitted entirely; the commit pipeline writes NULL.
- Column source names match the parser's header strings exactly (the C2 parser handles BOM and trims headers).

## `columns` — direct cell → field

```jsonc
{
  "columns": {
    "registration":      { "source": "Tail #" },
    "performedOn":       { "source": "Date", "format": { "kind": "date", "format": "MM/DD/YYYY" } },
    "aircraftTotalTime": { "source": "TT",   "format": { "kind": "decimal" } }
  }
}
```

| Property | Required | Notes                                                                                |
| -------- | -------- | ------------------------------------------------------------------------------------ |
| `source` | yes      | Column header in the uploaded file.                                                  |
| `format` | no       | Coercion spec. Omitted → inferred from the target field's type (see table below).    |

### Supported `format.kind`

| `kind`     | Accepted input                                  | Output JSON              | Target field types it can populate |
| ---------- | ----------------------------------------------- | ------------------------ | ---------------------------------- |
| `text`     | any string/number/boolean. Trim by default.     | `string`                 | text, enum, uuid                   |
| `decimal`  | string ("1,234.56") or finite number.           | `number`                 | decimal                            |
| `integer`  | string or number where `Number.isInteger`.      | `number`                 | integer                            |
| `date`     | ISO `YYYY-MM-DD`, or `MM/DD/YYYY`, or `DD/MM/YYYY`. | ISO date `YYYY-MM-DD` | date                               |
| `datetime` | any `new Date()`-parseable string.              | ISO 8601 timestamp string | datetime                           |
| `boolean`  | recognized truthy/falsy values (see below).     | `boolean`                | boolean                            |

#### Date sub-format

`format: "ISO"` (default), `"MM/DD/YYYY"`, `"DD/MM/YYYY"`. Any other value is rejected (`UNSUPPORTED_DATE_FORMAT`). XLSX serial-number date cells are **not** supported — the C2 parser is responsible for surfacing dates as ISO strings.

#### Boolean truthy/falsy

Defaults:

- Truthy: `["true", "yes", "y", "1"]`
- Falsy:  `["false", "no", "n", "0", ""]`

Case-insensitive; numeric `1` / `0` and JS `true` / `false` are always accepted. Anything else raises `FORMAT_ERROR`. Override with `truthy` / `falsy` arrays when the source uses exotic markers (e.g. `truthy: ["X"]`).

### Empty cells

A column cell that is `null`, `undefined`, or trims to `""` is treated as **field absent**: the engine leaves the target field unset and the per-entity validator (PMB-160 / C4) decides whether that's an error.

## `constants` — literal value → field

```jsonc
{
  "constants": {
    "category":      "airplane",
    "aircraftClass": "single_engine_land",
    "timeSource":    "tach"
  }
}
```

Use constants for fields the operator knows are uniform across the upload — typical with single-aircraft or single-fleet spreadsheets.

Constants are JSON literals (string, number, boolean, or null). The validator type-checks them against the target field's type and the enum vocabulary where applicable (`INVALID_CONSTANT_TYPE`, `INVALID_ENUM_CONSTANT`).

## `lookups` — tenant-scoped id resolution → field

Lookups resolve a foreign-key id from a key (either a row cell or a constant) by reading **only** the importing tenant's data. The production adapter runs each query under the `tenant_app` role so RLS scopes the SELECT — **cross-tenant resolution is a P0 bug**.

### Supported `kind`s

| `kind`                      | Key source     | Resolves                                                | Notes                                                                                  |
| --------------------------- | -------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `aircraft_by_registration`  | row cell       | `aircraft.id`                                           | Case-insensitive on registration.                                                       |
| `regime_by_code`            | constant       | `regimes.id`                                            | Use to attach the FAA regime to every aircraft without putting the UUID in a column.    |
| `component_by_serial`       | row cell       | `components.id`                                         | Requires `componentKind: "engine" \| "propeller" \| "appliance"`.                       |
| `inspection_program_by_code` | row cell      | `regime_inspection_program_templates.id`                | Resolves against the regime catalog.                                                    |

```jsonc
{
  "lookups": [
    { "kind": "regime_by_code",            "target": "regimeId",   "value": "FAA" },
    { "kind": "aircraft_by_registration",  "target": "aircraftId", "sourceColumn": "Tail #" },
    { "kind": "component_by_serial",       "target": "engineId",   "sourceColumn": "Engine SN", "componentKind": "engine" },
    { "kind": "inspection_program_by_code", "target": "inspectionProgramId", "sourceColumn": "Program" }
  ]
}
```

A miss (no row found for the key) does NOT abort the import. The engine surfaces a per-row `MappingError` with code `LOOKUP_MISS`; the row goes on to the per-entity validator and ultimately becomes an invalid row the operator can fix and re-upload. An exception from the adapter itself is surfaced as `LOOKUP_ERROR` (DB outage, etc.).

Lookups can only target fields whose type is `uuid`. Pointing one at a string field is rejected (`FORMAT_TYPE_MISMATCH`).

## Target field catalogs

Per-table closed list of fields the importer is allowed to populate. Anything not listed is rejected at validate-time as `UNKNOWN_TARGET_FIELD`.

### `aircraft`

| Field               | Type            | Required | Notes                                                          |
| ------------------- | --------------- | -------- | -------------------------------------------------------------- |
| `regimeId`          | uuid            | yes      | Typically a `regime_by_code` lookup.                            |
| `registration`      | text            | yes      |                                                                |
| `make`              | text            | yes      |                                                                |
| `model`             | text            | yes      |                                                                |
| `serialNumber`      | text            | yes      |                                                                |
| `yearManufactured`  | integer         | no       | DB CHECK: 1900–2100.                                            |
| `category`          | text            | yes      |                                                                |
| `aircraftClass`     | text            | yes      |                                                                |
| `airframeTotalTime` | decimal         | no       | DB default `0`. DB CHECK: ≥ 0.                                  |
| `timeSource`        | enum: `hobbs`, `tach` | yes |                                                                |

### `maintenance_entries`

| Field                 | Type                                                                | Required | Notes                                          |
| --------------------- | ------------------------------------------------------------------- | -------- | ---------------------------------------------- |
| `aircraftId`          | uuid                                                                | yes      | Typically `aircraft_by_registration`.           |
| `entryType`           | enum: `maintenance`, `annual_inspection`, `100_hour_inspection`, `inspection_program`, `ad_compliance` | yes | |
| `workPerformed`       | text                                                                | yes      | DB CHECK: non-empty after trim.                 |
| `performedOn`         | date                                                                | yes      | ISO calendar date.                              |
| `aircraftTotalTime`   | decimal                                                             | yes      | DB CHECK: ≥ 0.                                  |
| `inspectionProgramId`         | uuid                                                                | no       | Optional; resolves an inspection program template. |
| `signedAt`                    | datetime                                                            | no       | C3.5 emits an advisory when unbound; C4 gates `UNSIGNED_HISTORICAL` rows on this field. |
| `signedByCertificateNumber`   | text                                                                | no       | C3.5 advisory + C4 gate (same as `signedAt`). |
| `rtsTemplateCode`             | text                                                                | no       | C3.5 advisory + C4 gate (same as `signedAt`). |

Sign-off carriers (`signedAt`, `signedByCertificateNumber`, `rtsTemplateCode`) are part of the importer surface as `required: false` catalog fields. C4 is the authoritative row-time gate for the `UNSIGNED_HISTORICAL` status. `correctionOfId` is not yet on the importer surface and remains a future-flow concern.

### `components`

| Field               | Type                                            | Required | Notes                  |
| ------------------- | ----------------------------------------------- | -------- | ---------------------- |
| `kind`              | enum: `engine`, `propeller`, `appliance`        | yes      |                        |
| `serialNumber`      | text                                            | yes      | DB-unique per tenant + kind. |
| `make`              | text                                            | no       |                        |
| `model`             | text                                            | no       |                        |
| `tboHours`          | decimal                                         | no       | DB CHECK: > 0.         |
| `tboCalendarMonths` | integer                                         | no       | DB CHECK: > 0.         |
| `cycleLimit`        | integer                                         | no       | DB CHECK: > 0.         |

### `flight_time_entries`

| Field             | Type    | Required | Notes                                                                                         |
| ----------------- | ------- | -------- | --------------------------------------------------------------------------------------------- |
| `aircraftId`      | uuid    | yes      | Typically `aircraft_by_registration`.                                                          |
| `airframeTimeNew` | decimal | yes      | DB CHECK: ≥ 0.                                                                                 |
| `isOverride`      | boolean | no       | DB default `false`. When `true`, `overrideReason` must be non-empty (per-entity validator).    |
| `overrideReason`  | text    | no       | Required by C4 when `isOverride=true`.                                                         |
| `enteredAt`       | datetime | no      | Defaults to commit-time `now()` if omitted.                                                    |

## Validation outcomes

`validateMappingConfig` returns `{ ok, issues }`. Each issue has a stable `code`, a free-text `message`, and a JSON Pointer-ish `path` into the config.

| `code`                   | Meaning                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `INVALID_VERSION`        | `version` is not `"1"`.                                                                            |
| `UNKNOWN_TARGET_TABLE`   | `targetTable` is not one of the four V1 tables.                                                    |
| `UNKNOWN_TARGET_FIELD`   | A `columns` / `constants` / `lookups` entry targets a field absent from the table's catalog.        |
| `MISSING_REQUIRED_FIELD` | A required target field has no source in any of the three sections.                                |
| `DUPLICATE_TARGET_FIELD` | A target field is sourced by more than one of `columns`, `constants`, `lookups`.                   |
| `MISSING_SOURCE_COLUMN`  | A column mapping or column-driven lookup references a header not present in `availableColumns`.    |
| `UNSUPPORTED_FORMAT`     | `format.kind` is not one of the closed set.                                                        |
| `FORMAT_TYPE_MISMATCH`   | The declared format cannot populate the target field's type (e.g. decimal format for a date field). |
| `UNSUPPORTED_DATE_FORMAT` | `format.format` is not `ISO`, `MM/DD/YYYY`, or `DD/MM/YYYY`.                                       |
| `INVALID_CONSTANT_TYPE`  | A constant's JSON type does not match its target field's type.                                     |
| `INVALID_ENUM_CONSTANT`  | An enum field constant is outside the closed vocabulary.                                           |
| `INVALID_LOOKUP_KIND`    | Lookup `kind` is not in the supported set.                                                         |
| `MISSING_LOOKUP_KEY`     | A required lookup key is missing (e.g. `value` on `regime_by_code`, `sourceColumn` elsewhere).      |
| `MISSING_COMPONENT_KIND` | `component_by_serial` is missing the required `componentKind`.                                     |

## Worked example — paper-log maintenance entries

```jsonc
{
  "version": "1",
  "targetTable": "maintenance_entries",
  "sheet": "Maintenance",
  "columns": {
    "workPerformed":     { "source": "Description" },
    "performedOn":       { "source": "Date", "format": { "kind": "date", "format": "MM/DD/YYYY" } },
    "aircraftTotalTime": { "source": "TT",   "format": { "kind": "decimal" } }
  },
  "constants": {
    "entryType": "maintenance"
  },
  "lookups": [
    { "kind": "aircraft_by_registration", "target": "aircraftId", "sourceColumn": "Tail #" }
  ]
}
```

Given a parsed row:

```jsonc
{ "rowNumber": 17, "raw_cells": {
  "Tail #": "N12345", "Date": "03/14/2024",
  "Description": "Annual inspection per CFR 91.409", "TT": "1234.5"
} }
```

`applyMapping` yields:

```jsonc
{
  "mapped": {
    "workPerformed":     "Annual inspection per CFR 91.409",
    "performedOn":       "2024-03-14",
    "aircraftTotalTime": 1234.5,
    "entryType":         "maintenance",
    "aircraftId":        "<uuid resolved from the tenant-scoped lookup>"
  },
  "errors": []
}
```

## Tenant-scoping invariant

The mapping engine itself is pure — it never touches the database. The `LookupAdapter` is the only seam where I/O happens. Production callers (the C5 commit pipeline, PMB-161) wire up the production adapter inside the same `runAsTenant` block that holds the rest of the commit transaction. Tests in `@ga/import` use `InMemoryLookupAdapter` per-tenant; the suite includes a property test that asserts two tenants holding the same registration string resolve to different ids when called through different adapter instances.
