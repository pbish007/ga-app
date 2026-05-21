import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { schema as dbSchema } from "@ga/db";

type Schema = typeof dbSchema;

/**
 * Drizzle drivers accepted by the accounts package. pglite is used in
 * tests; postgres-js is the production driver. Mirror of `RegimeDb` so
 * the two packages stay portable together.
 */
export type AccountsDb =
  | PgliteDatabase<Schema>
  | PostgresJsDatabase<Schema>;
