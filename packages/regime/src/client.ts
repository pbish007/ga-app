import { eq } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { schema as dbSchema } from "@ga/db";

const {
  regimes,
  regimeInspectionProgramTemplates,
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
export type RegimeDirectiveSource = typeof regimeDirectiveSources.$inferSelect;
export type RegimeCredentialType = typeof regimeCredentialTypes.$inferSelect;
export type RegimeRtsTemplate = typeof regimeRtsTemplates.$inferSelect;
export type RegimeRetentionRule = typeof regimeRetentionRules.$inferSelect;

export interface RegimeBundle {
  regime: Regime;
  inspectionProgramTemplates: RegimeInspectionProgramTemplate[];
  directiveSources: RegimeDirectiveSource[];
  credentialTypes: RegimeCredentialType[];
  rtsTemplates: RegimeRtsTemplate[];
  retentionRules: RegimeRetentionRule[];
}

export interface NewRegimeTemplateInput {
  code: string;
  name: string;
  cadenceKind: string;
  intervalValue?: string | number | null;
  intervalUnit?: string | null;
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
      inspectionProgramTemplates,
      directiveSources,
      credentialTypes,
      rtsTemplates,
      retentionRules,
    ] = await Promise.all([
      this.listInspectionProgramTemplates(regimeId),
      this.listDirectiveSources(regimeId),
      this.listCredentialTypes(regimeId),
      this.listRtsTemplates(regimeId),
      this.listRetentionRules(regimeId),
    ]);
    return {
      regime,
      inspectionProgramTemplates,
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

    const inspectionProgramTemplates = templates.length
      ? await this.db
          .insert(regimeInspectionProgramTemplates)
          .values(
            templates.map((t) => ({
              regimeId: regime.id,
              code: t.code,
              name: t.name,
              cadenceKind: t.cadenceKind,
              intervalValue:
                t.intervalValue == null
                  ? null
                  : typeof t.intervalValue === "number"
                    ? String(t.intervalValue)
                    : t.intervalValue,
              intervalUnit: t.intervalUnit ?? null,
              description: t.description ?? null,
            })),
          )
          .returning()
      : [];

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
      inspectionProgramTemplates,
      directiveSources,
      credentialTypes,
      rtsTemplates,
      retentionRules,
    };
  }
}
