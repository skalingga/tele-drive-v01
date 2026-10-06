import type { TelegramObject } from "@teledrive/shared";
import { Database } from "./db.js";

interface TelegramObjectRow {
  file_id: string;
  peer_id: string;
  message_id: number;
  document_id: string;
  access_hash: string;
  file_reference: string;
  dc_id: number;
  created_at: string;
}

function toObject(row: TelegramObjectRow): TelegramObject {
  return {
    fileId: row.file_id,
    peerId: row.peer_id,
    messageId: row.message_id,
    documentId: row.document_id,
    accessHash: row.access_hash,
    fileReference: row.file_reference,
    dcId: row.dc_id,
    createdAt: row.created_at
  };
}

export class TelegramObjectRepository {
  constructor(private db: Database) {}

  async saveObject(obj: TelegramObject): Promise<TelegramObject> {
    this.db.run(
      `INSERT INTO telegram_objects (file_id, peer_id, message_id, document_id, access_hash, file_reference, dc_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(file_id) DO UPDATE SET
         peer_id = excluded.peer_id, message_id = excluded.message_id, document_id = excluded.document_id,
         access_hash = excluded.access_hash, file_reference = excluded.file_reference, dc_id = excluded.dc_id`,
      obj.fileId, obj.peerId, obj.messageId, obj.documentId, obj.accessHash, obj.fileReference, obj.dcId, obj.createdAt
    );
    return obj;
  }

  /** Row-level scoped: only returns the object if the file belongs to `userId`. */
  async getByFileId(userId: string, fileId: string): Promise<TelegramObject | null> {
    const row = this.db.get<TelegramObjectRow>(
      `SELECT t.* FROM telegram_objects t JOIN files f ON f.id = t.file_id WHERE t.file_id = ? AND f.user_id = ?`,
      fileId, userId
    );
    return row ? toObject(row) : null;
  }

  async updateFileReference(userId: string, fileId: string, newReference: string): Promise<void> {
    this.db.run(
      `UPDATE telegram_objects SET file_reference = ?
       WHERE file_id = ? AND file_id IN (SELECT id FROM files WHERE user_id = ?)`,
      newReference, fileId, userId
    );
  }
}
