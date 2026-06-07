import { and, eq, isNull, sql } from "drizzle-orm";

import { schema as dbSchema } from "@ga/db";

import type { ImportTx } from "./types.js";

const { regimeRtsTemplates, userCredentials } = dbSchema;

/**
 * One resolved RTS template at commit time. The C5 commit pipeline
 * needs both the template id (to populate `maintenance_entries.rts_template_id`)
 * and the body string (to render and snapshot as `rts_rendered_body`).
 */
export interface ResolvedRtsTemplate {
  id: string;
  body: string;
}

/**
 * Look up an RTS template by regime + code, case-insensitive on code.
 * Returns null on miss — the maintenance-entry inserter treats a miss
 * as a hard commit failure (the C4 validator should have already
 * rejected the row at validation time, so a miss at commit time means
 * the catalog drifted between validate and commit).
 */
export async function findRtsTemplate(
  tx: ImportTx,
  regimeId: string,
  code: string,
): Promise<ResolvedRtsTemplate | null> {
  const rows = await tx
    .select({ id: regimeRtsTemplates.id, body: regimeRtsTemplates.body })
    .from(regimeRtsTemplates)
    .where(
      and(
        eq(regimeRtsTemplates.regimeId, regimeId),
        sql`lower(${regimeRtsTemplates.code}) = lower(${code})`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Resolve a certificate number to its active user credential. Matching
 * is case-insensitive (mirrors the C4 cursor contract). "Active" means
 * `revoked_at IS NULL`; expired credentials may still be matched
 * because historical sign-offs remain valid when the signer's
 * credential later expired (PMB-160 spec note).
 *
 * Returns null on miss.
 */
export async function findCredentialByCertificateNumber(
  tx: ImportTx,
  certificateNumber: string,
): Promise<{ credentialId: string; userId: string } | null> {
  const rows = await tx
    .select({
      id: userCredentials.id,
      userId: userCredentials.userId,
    })
    .from(userCredentials)
    .where(
      and(
        sql`lower(${userCredentials.certificateNumber}) = lower(${certificateNumber})`,
        isNull(userCredentials.revokedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { credentialId: row.id, userId: row.userId };
}

/**
 * Render an RTS template body by substituting `{{work_performed}}`
 * with the entry's work-performed text. The substitution is a literal
 * string replace; the body strings the FAA regime ships (see migration
 * 0013) use exactly this token. The result is the value the commit
 * pipeline writes to `maintenance_entries.rts_rendered_body`, frozen
 * for the life of the record.
 */
export function renderRtsBody(body: string, workPerformed: string): string {
  return body.replaceAll("{{work_performed}}", workPerformed);
}
