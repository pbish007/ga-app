import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { schema as dbSchema } from "@ga/db";

type Schema = typeof dbSchema;

/**
 * Drizzle drivers accepted by the aircraft package. Mirrors the
 * portability shape of @ga/accounts and @ga/regime.
 */
export type AircraftDb =
  | PgliteDatabase<Schema>
  | PostgresJsDatabase<Schema>;
