import { eq, inArray } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { schema as dbSchema } from "@ga/db";

const {
  regimes,
  regimeInspectionProgramTemplates,
  regimeInspectionProgramIntervals,
  regimeDirectiveSources,
  regimeCredentialTypes,
  regimeRtsTemplates,
  regimeRetentionRules,
} = dbSchema;

type Schema = typeof dbSchema;

/**
 * The accepted drizzle drivers for the regime client. pglite is used
 * by tests; postgres-js (Neon/managed Postgres) is the runtime driver.
 *
 * Downstream packages should accept `RegimeDb` rather than naming a
 * concrete driver, so the regime layer stays portable.
 */
export type RegimeDb =
  | PgliteDatabase<Schema>
  | PostgresJsDatabase<Schema>;

export type Regime = typeof regimes.$inferSelect;
export type RegimeInspectionProgramTemplate =
  typeof regimeInspectionProgramTemplates.$inferSelect;
export type RegimeInspectionProgramInterval =
  typeof regimeInspectionProgramIntervals.$inferSelect;
export type RegimeDirectiveSource = typeof regimeDirectiveSources.$inferSelect;
export type RegimeCredentialType = typeof regimeCredentialTypes.$inferSelect;
export type RegimeRtsTemplate = typeof regimeRtsTemplates.$inferSelect;
export type RegimeRetentionRule = typeof regimeRetentionRules.$inferSelect;

/**
 * A regime inspection program with its 0..N child intervals grouped
 * together. This is the shape the compliance engine consumes — it
 * never sees the raw flat tables, so a future schema split (e.g. moving
 * intervals into a separate package) is invisible to consumers.
 */
export interface RegimeInspectionProgram {
  template: RegimeInspectionProgramTemplate;
  intervals: RegimeInspectionProgramInterval[];
}

export interface RegimeBundle {
  regime: Regime;
  inspectionPrograms: RegimeInspectionProgram[];
  directiveSources: RegimeDirectiveSource[];
  credentialTypes: RegimeCredentialType[];
  rtsTemplates: RegimeRtsTemplate[];
  retentionRules: RegimeRetentionRule[];
}

export interface NewRegimeIntervalInput {
  kind: "hour" | "calendar" | "cycle";
  value: string | number;
  unit: string;
}

export interface NewRegimeTemplateInput {
  code: string;
  name: string;
  cadenceKind: "single" | "whichever_comes_first" | "custom";
  intervals?: NewRegimeIntervalInput[];
  description?: string | null;
}

export interface NewRegimeDirectiveSourceInput {
  code: string;
  name: string;
  sourceUri?: string | null;
  description?: string | null;
}

export interface NewRegimeCredentialTypeInput {
  code: string;
  name: string;
  authorizesSignoff?: boolean;
  description?: string | null;
}

export interface NewRegimeRtsTemplateInput {
  code: string;
  name: string;
  body: string;
}

export interface NewRegimeRetentionRuleInput {
  recordKind: string;
  retentionPeriodKind: string;
  retentionPeriodValue?: number | null;
  description?: string | null;
}

export interface NewRegimeBundle {
  code: string;
  name: string;
  jurisdiction: string;
  active?: boolean;
  inspectionProgramTemplates?: NewRegimeTemplateInput[];
  directiveSources?: NewRegimeDirectiveSourceInput[];
  credentialTypes?: NewRegimeCredentialTypeInput[];
  rtsTemplates?: NewRegimeRtsTemplateInput[];
  retentionRules?: NewRegimeRetentionRuleInput[];
}

export class RegimeNotFoundError extends Error {
  constructor(criterion: string) {
    super(`regime not found: ${criterion}`);
    this.name = "RegimeNotFoundError";
  }
}

/**
 * Typed accessor over the regulatory regime tables. This is the only
 * code path the app should use to read regime-driven values. App code
 * MUST NOT hardcode regulatory strings — they live in the regime
 * row and its child tables.
 *
 * See `packages/db/migrations/0001_create_regimes.sql` for the seeded
 * FAA content and the ADR on PMB-8 for the design contract.
 */
export class RegimeClient {
  constructor(private readonly db: RegimeDb) {}

  async list(): Promise<Regime[]> {
    return this.db.select().from(regimes);
  }

  async getById(id: string): Promise<Regime> {
    const rows = await this.db
      .select()
      .from(regimes)
      .where(eq(regimes.id, id));
    const row = rows[0];
    if (!row) throw new RegimeNotFoundError(`id=${id}`);
    return row;
  }

  async getByCode(code: string): Promise<Regime> {
    const rows = await this.db
      .select()
      .from(regimes)
      .where(eq(regimes.code, code));
    const row = rows[0];
    if (!row) throw new RegimeNotFoundError(`code=${code}`);
    return row;
  }

  async findByCode(code: string): Promise<Regime | null> {
    const rows = await this.db
      .select()
      .from(regimes)
      .where(eq(regimes.code, code));
    return rows[0] ?? null;
  }

  async listInspectionProgramTemplates(
    regimeId: string,
  ): Promise<RegimeInspectionProgramTemplate[]> {
    return this.db
      .select()
      .from(regimeInspectionProgramTemplates)
      .where(eq(regimeInspectionProgramTemplates.regimeId, regimeId));
  }

  /**
   * List every inspection program for a regime grouped with its
   * intervals. This is the shape the compliance engine consumes; the
   * intervals[] is empty for `custom` programs (e.g. progressive).
   */
  async listInspectionPrograms(
    regimeId: string,
  ): Promise<RegimeInspectionProgram[]> {
    const templates = await this.listInspectionProgramTemplates(regimeId);
    if (templates.length === 0) return [];
    const intervals = await this.db
      .select()
      .from(regimeInspectionProgramIntervals)
      .where(
        inArray(
          regimeInspectionProgramIntervals.templateId,
          templates.map((t) => t.id),
        ),
      );
    const byTemplate = new Map<string, RegimeInspectionProgramInterval[]>();
    for (const interval of intervals) {
      const arr = byTemplate.get(interval.templateId) ?? [];
      arr.push(interval);
      byTemplate.set(interval.templateId, arr);
    }
    return templates.map((template) => ({
      template,
      intervals: byTemplate.get(template.id) ?? [],
    }));
  }

  /**
   * Fetch a single inspection program (template + intervals) by id.
   * Used by the compliance engine when the caller already has a
   * specific program id (e.g. from a subscription row).
   */
  async getInspectionProgram(
    templateId: string,
  ): Promise<RegimeInspectionProgram | null> {
    const templates = await this.db
      .select()
      .from(regimeInspectionProgramTemplates)
      .where(eq(regimeInspectionProgramTemplates.id, templateId));
    const template = templates[0];
    if (!template) return null;
    const intervals = await this.db
      .select()
      .from(regimeInspectionProgramIntervals)
      .where(eq(regimeInspectionProgramIntervals.templateId, templateId));
    return { template, intervals };
  }

  async listDirectiveSources(regimeId: string): Promise<RegimeDirectiveSource[]> {
    return this.db
      .select()
      .from(regimeDirectiveSources)
      .where(eq(regimeDirectiveSources.regimeId, regimeId));
  }

  async listCredentialTypes(regimeId: string): Promise<RegimeCredentialType[]> {
    return this.db
      .select()
      .from(regimeCredentialTypes)
      .where(eq(regimeCredentialTypes.regimeId, regimeId));
  }

  async listRtsTemplates(regimeId: string): Promise<RegimeRtsTemplate[]> {
    return this.db
      .select()
      .from(regimeRtsTemplates)
      .where(eq(regimeRtsTemplates.regimeId, regimeId));
  }

  async listRetentionRules(regimeId: string): Promise<RegimeRetentionRule[]> {
    return this.db
      .select()
      .from(regimeRetentionRules)
      .where(eq(regimeRetentionRules.regimeId, regimeId));
  }

  async loadBundle(regimeId: string): Promise<RegimeBundle> {
    const regime = await this.getById(regimeId);
    const [
      inspectionPrograms,
      directiveSources,
      credentialTypes,
      rtsTemplates,
      retentionRules,
    ] = await Promise.all([
      this.listInspectionPrograms(regimeId),
      this.listDirectiveSources(regimeId),
      this.listCredentialTypes(regimeId),
      this.listRtsTemplates(regimeId),
      this.listRetentionRules(regimeId),
    ]);
    return {
      regime,
      inspectionPrograms,
      directiveSources,
      credentialTypes,
      rtsTemplates,
      retentionRules,
    };
  }

  /**
   * Insert a new regime + its child rows. This is intentionally the
   * ONLY way a non-FAA regime enters the system today (no migration
   * required — that's the K1 seam being tested). The test
   * `regime.test.ts` calls this to prove "CARS is data-only".
   */
  async createBundle(input: NewRegimeBundle): Promise<RegimeBundle> {
    const [regime] = await this.db
      .insert(regimes)
      .values({
        code: input.code,
        name: input.name,
        jurisdiction: input.jurisdiction,
        active: input.active ?? true,
      })
      .returning();
    if (!regime) {
      throw new Error(`failed to insert regime code=${input.code}`);
    }

    const templates = input.inspectionProgramTemplates ?? [];
    const sources = input.directiveSources ?? [];
    const credentials = input.credentialTypes ?? [];
    const rts = input.rtsTemplates ?? [];
    const retention = input.retentionRules ?? [];

    const insertedTemplates = templates.length
      ? await this.db
          .insert(regimeInspectionProgramTemplates)
          .values(
            templates.map((t) => ({
              regimeId: regime.id,
              code: t.code,
              name: t.name,
              cadenceKind: t.cadenceKind,
              description: t.description ?? null,
            })),
          )
          .returning()
      : [];

    // Insert intervals — flat list keyed back to their template by code.
    const intervalRows = templates.flatMap((t, i) => {
      const tpl = insertedTemplates[i];
      if (!tpl) return [];
      return (t.intervals ?? []).map((iv) => ({
        templateId: tpl.id,
        kind: iv.kind,
        value: typeof iv.value === "number" ? String(iv.value) : iv.value,
        unit: iv.unit,
      }));
    });
    const insertedIntervals = intervalRows.length
      ? await this.db
          .insert(regimeInspectionProgramIntervals)
          .values(intervalRows)
          .returning()
      : [];
    const intervalsByTemplate = new Map<
      string,
      RegimeInspectionProgramInterval[]
    >();
    for (const iv of insertedIntervals) {
      const arr = intervalsByTemplate.get(iv.templateId) ?? [];
      arr.push(iv);
      intervalsByTemplate.set(iv.templateId, arr);
    }
    const inspectionPrograms: RegimeInspectionProgram[] = insertedTemplates.map(
      (template) => ({
        template,
        intervals: intervalsByTemplate.get(template.id) ?? [],
      }),
    );

    const directiveSources = sources.length
      ? await this.db
          .insert(regimeDirectiveSources)
          .values(
            sources.map((s) => ({
              regimeId: regime.id,
              code: s.code,
              name: s.name,
              sourceUri: s.sourceUri ?? null,
              description: s.description ?? null,
            })),
          )
          .returning()
      : [];

    const credentialTypes = credentials.length
      ? await this.db
          .insert(regimeCredentialTypes)
          .values(
            credentials.map((c) => ({
              regimeId: regime.id,
              code: c.code,
              name: c.name,
              authorizesSignoff: c.authorizesSignoff ?? false,
              description: c.description ?? null,
            })),
          )
          .returning()
      : [];

    const rtsTemplates = rts.length
      ? await this.db
          .insert(regimeRtsTemplates)
          .values(
            rts.map((r) => ({
              regimeId: regime.id,
              code: r.code,
              name: r.name,
              body: r.body,
            })),
          )
          .returning()
      : [];

    const retentionRules = retention.length
      ? await this.db
          .insert(regimeRetentionRules)
          .values(
            retention.map((r) => ({
              regimeId: regime.id,
              recordKind: r.recordKind,
              retentionPeriodKind: r.retentionPeriodKind,
              retentionPeriodValue: r.retentionPeriodValue ?? null,
              description: r.description ?? null,
            })),
          )
          .returning()
      : [];

    return {
      regime,
      inspectionPrograms,
      directiveSources,
      credentialTypes,
      rtsTemplates,
      retentionRules,
    };
  }
}
