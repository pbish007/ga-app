import { handleAttachmentUpload } from "../../../lib/attachments-handler";
import { buildDocumentsService } from "../../../lib/documents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const service = buildDocumentsService();
  return handleAttachmentUpload(request, { service });
}
