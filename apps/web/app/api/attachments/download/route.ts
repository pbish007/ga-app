import { handleAttachmentDownload } from "../../../../lib/attachments-handler";
import { buildDocumentsService } from "../../../../lib/documents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const service = buildDocumentsService();
  return handleAttachmentDownload(request, { service });
}
