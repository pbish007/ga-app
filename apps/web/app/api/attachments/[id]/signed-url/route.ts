import { handleAttachmentMintSignedUrl } from "../../../../../lib/attachments-handler";
import { buildDocumentsService } from "../../../../../lib/documents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const params = await context.params;
  const service = buildDocumentsService();
  return handleAttachmentMintSignedUrl(request, { params }, { service });
}
