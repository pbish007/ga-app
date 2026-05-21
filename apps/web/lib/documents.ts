import {
  DocumentsService,
  VercelBlobDriver,
  requireBlobToken,
  type DocumentsDb,
} from "@ga/storage";

import { getDb } from "./db.js";

/**
 * Wire the production DocumentsService. Tests instantiate the service
 * directly with a memory driver and a pglite database — they never go
 * through this factory.
 */
export function buildDocumentsService(): DocumentsService {
  const db: DocumentsDb = getDb();
  const driver = new VercelBlobDriver({ token: requireBlobToken() });
  return new DocumentsService(db, driver, "vercel_blob");
}
