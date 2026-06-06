import {
  AIRCRAFT_TIME_SOURCES,
  COMPONENT_KINDS,
  IMPORT_JOB_TARGET_TABLES,
  MAINTENANCE_ENTRY_TYPES,
} from "@ga/db";

import {
  COLUMN_FORMAT_KINDS,
  LOOKUP_KINDS,
  SUPPORTED_DATE_FORMATS,
} from "./mapping-config.js";

/**
 * JSON Schema (draft 2020-12) for the V1 mapping_config shape.
 *
 * Two consumers:
 *   - the importer UI (PMB-95 F2/F3) renders the schema as a hint
 *     surface and uses it to validate operator-authored configs at
 *     edit time;
 *   - external integrations / scripts validate uploads against this
 *     schema before POSTing an import job.
 *
 * The runtime validator (`validateMappingConfig`) is the source of
 * truth for semantic checks (unknown target fields, missing required
 * fields, etc.); this schema covers structural shape. The two are
 * intentionally complementary, not redundant.
 */
export const MAPPING_CONFIG_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://gaapp.io/schemas/import/mapping-config-v1.json",
  title: "ImportMappingConfig",
  type: "object",
  required: ["version", "targetTable"],
  additionalProperties: false,
  properties: {
    version: { const: "1" },
    targetTable: {
      enum: [...IMPORT_JOB_TARGET_TABLES],
      description:
        "One of the four V1 live tables the importer is allowed to write.",
    },
    sheet: {
      type: "string",
      description:
        "Optional XLSX worksheet name. The parser uses the first sheet by default.",
    },
    columns: {
      type: "object",
      description:
        "Map of target field name -> column mapping. Direct cell-to-field assignment.",
      additionalProperties: {
        type: "object",
        required: ["source"],
        additionalProperties: false,
        properties: {
          source: {
            type: "string",
            minLength: 1,
            description:
              "Header (column name) the parser produced from the source file.",
          },
          format: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["kind"],
                properties: {
                  kind: { const: "text" },
                  trim: { type: "boolean" },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["kind"],
                properties: {
                  kind: { const: "date" },
                  format: { enum: [...SUPPORTED_DATE_FORMATS] },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["kind"],
                properties: { kind: { const: "datetime" } },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["kind"],
                properties: { kind: { const: "decimal" } },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["kind"],
                properties: { kind: { const: "integer" } },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["kind"],
                properties: {
                  kind: { const: "boolean" },
                  truthy: { type: "array", items: { type: "string" } },
                  falsy: { type: "array", items: { type: "string" } },
                },
              },
            ],
          },
        },
      },
    },
    constants: {
      type: "object",
      description:
        "Map of target field name -> literal value to write into every mapped row.",
      additionalProperties: {
        type: ["string", "number", "boolean", "null"],
      },
    },
    lookups: {
      type: "array",
      description:
        "Tenant-scoped id resolutions. Each lookup writes one target field.",
      items: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "target", "sourceColumn"],
            properties: {
              kind: { const: "aircraft_by_registration" },
              target: { type: "string", minLength: 1 },
              sourceColumn: { type: "string", minLength: 1 },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "target", "value"],
            properties: {
              kind: { const: "regime_by_code" },
              target: { type: "string", minLength: 1 },
              value: { type: "string", minLength: 1 },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "target", "sourceColumn", "componentKind"],
            properties: {
              kind: { const: "component_by_serial" },
              target: { type: "string", minLength: 1 },
              sourceColumn: { type: "string", minLength: 1 },
              componentKind: { enum: [...COMPONENT_KINDS] },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "target", "sourceColumn"],
            properties: {
              kind: { const: "inspection_program_by_code" },
              target: { type: "string", minLength: 1 },
              sourceColumn: { type: "string", minLength: 1 },
            },
          },
        ],
      },
    },
  },
  $defs: {
    // Catalog of enum values surfaced for UI hint rendering. Not used
    // by the structural validator (per-field enum membership is
    // checked semantically in validateMappingConfig).
    enums: {
      aircraft_time_source: { enum: [...AIRCRAFT_TIME_SOURCES] },
      component_kind: { enum: [...COMPONENT_KINDS] },
      maintenance_entry_type: { enum: [...MAINTENANCE_ENTRY_TYPES] },
      column_format_kind: { enum: [...COLUMN_FORMAT_KINDS] },
      lookup_kind: { enum: [...LOOKUP_KINDS] },
    },
  },
} as const;
