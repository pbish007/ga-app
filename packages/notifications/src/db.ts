/**
 * Shared driver-portable shapes for @ga/notifications.
 *
 * Drizzle's pglite and postgres-js drivers return different shapes from
 * `db.execute(sql\`…\`)` — pglite returns `{ rows: T[] }`, postgres-js
 * returns a `T[]`-shaped `RowList`. Code in this package goes through
 * `executeRows()` so it works under both.
 */

import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { SQL } from "drizzle-orm";

import { schema as dbSchema } from "@ga/db";

type Schema = typeof dbSchema;

export type NotificationsDb =
  | PgliteDatabase<Schema>
  | PostgresJsDatabase<Schema>;

export interface DbExecutor {
  execute(q: SQL): Promise<unknown>;
}

/**
 * Normalise a driver-specific execute() result to a plain array of rows.
 * Accepts both `{ rows: T[] }` (pglite) and `T[]` (postgres-js).
 */
export async function executeRows<T>(
  db: DbExecutor,
  query: SQL,
): Promise<T[]> {
  const raw = (await db.execute(query)) as
    | { rows: T[] }
    | readonly T[]
    | T[];
  if (Array.isArray(raw)) return raw as T[];
  const maybe = raw as { rows?: T[] };
  if (maybe && Array.isArray(maybe.rows)) return maybe.rows;
  return [];
}
