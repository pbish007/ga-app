import { schema as dbSchema } from "@ga/db";
import { DEFAULT_REGIME_CODE, RegimeClient } from "@ga/regime";

import type { AccountsDb } from "./db.js";

const { organizations } = dbSchema;

import type { OrgType, Organization } from "@ga/db";

export interface CreateOrganizationInput {
  name: string;
  orgType: OrgType;
  /**
   * Optional override. Defaults to the FAA regime (`DEFAULT_REGIME_CODE`)
   * — the **K2 regime seam**. Onboarding UI does not need to expose this.
   */
  defaultRegimeId?: string;
}

export class OrganizationService {
  private regimeClient: RegimeClient;

  constructor(private readonly db: AccountsDb) {
    this.regimeClient = new RegimeClient(db);
  }

  /**
   * Resolves the platform's default regime id. Cached per service
   * instance — onboarding hits this for every org create.
   */
  async getDefaultRegimeId(): Promise<string> {
    const regime = await this.regimeClient.getByCode(DEFAULT_REGIME_CODE);
    return regime.id;
  }

  async create(input: CreateOrganizationInput): Promise<Organization> {
    const defaultRegimeId =
      input.defaultRegimeId ?? (await this.getDefaultRegimeId());
    const [row] = await this.db
      .insert(organizations)
      .values({
        name: input.name,
        orgType: input.orgType,
        defaultRegimeId,
      })
      .returning();
    if (!row) {
      throw new Error("failed to insert organization");
    }
    return row;
  }
}
