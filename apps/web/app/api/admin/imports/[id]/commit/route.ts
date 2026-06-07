import { handleCommitImport } from "../../../../../../lib/admin/imports-handler";
import { getDb, getDirectDb } from "../../../../../../lib/db";
import { buildDocumentsService } from "../../../../../../lib/documents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function buildDeps() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET must be set");
  return {
    db: getDb(),
    directDb: getDirectDb(),
    documentsService: buildDocumentsService(),
    secret,
  };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleCommitImport(request, context, buildDeps());
}
