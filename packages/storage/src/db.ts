import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { schema as dbSchema } from "@ga/db";

type Schema = typeof dbSchema;

/**
 * Drizzle drivers accepted by the storage package. pglite is used in
 * tests; postgres-js is the production driver. Mirror of `AccountsDb`.
 */
export type DocumentsDb = PgliteDatabase<Schema> | PostgresJsDatabase<Schema>;
