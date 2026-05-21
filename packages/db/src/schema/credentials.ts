import {
  date,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./accounts.js";
import { regimeCredentialTypes } from "./regime.js";

/**
 * A user's regulatory credential (A&P, IA, repairman, …) modelled as a
 * row pointing at the data-driven `regime_credential_types` table.
 *
 * Tenant-agnostic — credentials follow the person across the orgs they
 * belong to. The sign-off check reads
 * `regime_credential_types.authorizes_signoff`; app code never switches
 * on credential code strings. See migration `0006_user_credentials.sql`
 * and the A2.3 ticket on PMB-34 for the design contract.
 */
export const userCredentials = pgTable(
  "user_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    regimeCredentialTypeId: uuid("regime_credential_type_id")
      .notNull()
      .references(() => regimeCredentialTypes.id, { onDelete: "restrict" }),
    certificateNumber: text("certificate_number"),
    issuedOn: date("issued_on", { mode: "string" }).notNull(),
    expiresOn: date("expires_on", { mode: "string" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    activeIdx: index("user_credentials_active_idx").on(
      t.userId,
      t.regimeCredentialTypeId,
    ),
  }),
);

export type UserCredential = typeof userCredentials.$inferSelect;
export type NewUserCredential = typeof userCredentials.$inferInsert;
