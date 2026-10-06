import crypto from "node:crypto";
import {
  type FileItem,
  type StorageAnalytics,
  type TelegramObject,
  AppError,
  ErrorCode,
  encodeCursor,
  decodeCursor
} from "@teledrive/shared";
import { Database, nowIso, escapeLike } from "./db.js";

export type FileSort = "name_asc" | "name_desc" | "size_asc" | "size_desc" | "date_asc" | "date_desc";
export type FileTypeFilter = "all" | "image" | "video" | "audio" | "document" | "archive" | "other";

export interface ListFilesOptions {
  folderId?: string | null;
  cursor?: string;
  limit?: number;
  filter?: "all" | "favorites" | "trash" | "recent";
  sort?: FileSort;
  type?: FileTypeFilter;
}

interface FileRow {
  id: string;
  user_id: string;
  folder_id: string | null;
  name: string;
  mime_type: string;
  size_bytes: number;
  checksum: string | null;
  status: FileItem["status"];
  deleted_at: string | null;
  trash_root_id: string | null;
  created_at: string;
  updated_at: string;
  is_favorite?: number;
}

function toFile(row: FileRow): FileItem {
  return {
    id: row.id,
    userId: row.user_id,
    folderId: row.folder_id,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    checksum: row.checksum,
    status: row.status,
    isFavorite: row.is_favorite === undefined ? undefined : row.is_favorite === 1,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const TYPE_SQL: Record<Exclude<FileTypeFilter, "all" | "other">, string> = {
  image: "f.mime_type LIKE 'image/%'",
  video: "f.mime_type LIKE 'video/%'",
  audio: "f.mime_type LIKE 'audio/%'",
  document:
    "(f.mime_type = 'application/pdf' OR f.mime_type LIKE 'text/%' OR f.mime_type LIKE '%word%' OR f.mime_type LIKE '%excel%'" +
    " OR f.mime_type LIKE '%spreadsheet%' OR f.mime_type LIKE '%presentation%' OR f.mime_type LIKE '%powerpoint%' OR f.mime_type LIKE '%opendocument%')",
  archive:
    "(f.mime_type LIKE '%zip%' OR f.mime_type LIKE '%x-tar%' OR f.mime_type LIKE '%x-rar%' OR f.mime_type LIKE '%x-7z%'" +
    " OR f.mime_type LIKE '%vnd.rar%' OR f.mime_type LIKE '%x-bzip%' OR f.mime_type LIKE '%x-xz%')"
};

interface SortSpec {
  column: string;
  dir: "ASC" | "DESC";
  key: (row: FileRow) => string | number;
}

const SORTS: Record<FileSort | "recent", SortSpec> = {
  name_asc: { column: "f.name COLLATE NOCASE", dir: "ASC", key: r => r.name },
  name_desc: { column: "f.name COLLATE NOCASE", dir: "DESC", key: r => r.name },
  size_asc: { column: "f.size_bytes", dir: "ASC", key: r => r.size_bytes },
  size_desc: { column: "f.size_bytes", dir: "DESC", key: r => r.size_bytes },
  date_asc: { column: "f.created_at", dir: "ASC", key: r => r.created_at },
  date_desc: { column: "f.created_at", dir: "DESC", key: r => r.created_at },
  recent: { column: "f.updated_at", dir: "DESC", key: r => r.updated_at }
};

const SELECT_FILE = `SELECT f.*, EXISTS (SELECT 1 FROM favorites fav WHERE fav.user_id = f.user_id AND fav.file_id = f.id) AS is_favorite FROM files f`;

/** Rows that were permanently deleted, with the Telegram messages that must be removed. */
export interface PurgePlan {
  fileIds: string[];
  folderIds: string[];
  objects: TelegramObject[];
}

export class FileRepository {
  constructor(private db: Database) {}

  private requireActiveFolder(userId: string, folderId: string, message: string): void {
    const folder = this.db.get<{ id: string }>("SELECT id FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NULL", folderId, userId);
    if (!folder) throw new AppError(ErrorCode.NOT_FOUND, message, 404);
  }

  async createFile(
    userId: string,
    params: { name: string; mimeType: string; sizeBytes: number; folderId?: string | null; status?: FileItem["status"] }
  ): Promise<FileItem> {
    return this.db.transaction(() => {
      if (params.folderId) this.requireActiveFolder(userId, params.folderId, "Target folder not found");
      const now = nowIso();
      const id = `fil_${crypto.randomUUID()}`;
      this.db.run(
        `INSERT INTO files (id, user_id, folder_id, name, mime_type, size_bytes, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, userId, params.folderId ?? null, params.name.trim(), params.mimeType || "application/octet-stream",
        params.sizeBytes, params.status ?? "pending", now, now
      );
      return toFile(this.db.get<FileRow>(`${SELECT_FILE} WHERE f.id = ?`, id)!);
    });
  }

  async getFileById(userId: string, fileId: string): Promise<FileItem | null> {
    const row = this.db.get<FileRow>(`${SELECT_FILE} WHERE f.id = ? AND f.user_id = ?`, fileId, userId);
    return row ? toFile(row) : null;
  }

  async listFiles(userId: string, options: ListFilesOptions = {}): Promise<{ items: FileItem[]; nextCursor: string | null; total: number }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const where: string[] = ["f.user_id = ?"];
    const params: (string | number | null)[] = [userId];
    let sort = SORTS[options.sort ?? "date_desc"];

    switch (options.filter ?? "all") {
      case "trash":
        // Only items the user trashed directly; contents of trashed folders come back with the folder.
        where.push("f.deleted_at IS NOT NULL", "f.trash_root_id = f.id");
        break;
      case "favorites":
        where.push("f.deleted_at IS NULL", "EXISTS (SELECT 1 FROM favorites fav WHERE fav.user_id = f.user_id AND fav.file_id = f.id)");
        break;
      case "recent":
        where.push("f.deleted_at IS NULL");
        sort = SORTS.recent;
        break;
      default: {
        const folderId = options.folderId ?? null;
        if (folderId) this.requireActiveFolder(userId, folderId, "Folder not found");
        where.push("f.deleted_at IS NULL", "f.folder_id IS ?");
        params.push(folderId);
      }
    }

    const type = options.type ?? "all";
    if (type === "other") {
      where.push(`NOT (${Object.values(TYPE_SQL).join(" OR ")})`);
    } else if (type !== "all") {
      where.push(TYPE_SQL[type]);
    }

    return this.page(where, params, sort, limit, options.cursor);
  }

  async searchFiles(userId: string, query: string, cursor?: string, limit: number = 50): Promise<{ items: FileItem[]; nextCursor: string | null; total: number }> {
    const where = ["f.user_id = ?", "f.deleted_at IS NULL", "f.name LIKE ? ESCAPE '\\'"];
    const params = [userId, `%${escapeLike(query.trim())}%`];
    return this.page(where, params, SORTS.date_desc, Math.min(Math.max(limit, 1), 200), cursor);
  }

  /** Keyset pagination: stable while rows are inserted/deleted, no offsets. */
  private page(
    where: string[],
    params: (string | number | null)[],
    sort: SortSpec,
    limit: number,
    rawCursor?: string
  ): { items: FileItem[]; nextCursor: string | null; total: number } {
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM files f WHERE ${where.join(" AND ")}`, ...params)!.n;

    const conditions = [...where];
    const values = [...params];
    if (rawCursor) {
      const cursor = decodeCursor(rawCursor);
      if (!cursor) throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid cursor", 400);
      const op = sort.dir === "ASC" ? ">" : "<";
      conditions.push(`(${sort.column} ${op} ? OR (${sort.column} = ? AND f.id ${op} ?))`);
      values.push(cursor.v, cursor.v, cursor.id);
    }

    const rows = this.db.all<FileRow>(
      `${SELECT_FILE} WHERE ${conditions.join(" AND ")} ORDER BY ${sort.column} ${sort.dir}, f.id ${sort.dir} LIMIT ?`,
      ...values, limit + 1
    );
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    return {
      items: pageRows.map(toFile),
      nextCursor: hasMore && last ? encodeCursor({ v: sort.key(last), id: last.id }) : null,
      total
    };
  }

  /** Rename/move an active file. */
  async updateFile(userId: string, fileId: string, updates: { name?: string; folderId?: string | null }): Promise<FileItem> {
    return this.db.transaction(() => {
      const file = this.db.get<FileRow>("SELECT * FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL", fileId, userId);
      if (!file) throw new AppError(ErrorCode.NOT_FOUND, "File not found", 404);

      const folderId = updates.folderId !== undefined ? updates.folderId : file.folder_id;
      if (updates.folderId) this.requireActiveFolder(userId, updates.folderId, "Destination folder not found");
      const name = updates.name !== undefined ? updates.name.trim() : file.name;

      this.db.run("UPDATE files SET name = ?, folder_id = ?, updated_at = ? WHERE id = ? AND user_id = ?", name, folderId, nowIso(), fileId, userId);
      return toFile(this.db.get<FileRow>(`${SELECT_FILE} WHERE f.id = ?`, fileId)!);
    });
  }

  /** Internal (worker) status transition — not exposed to API callers. */
  async setStatus(userId: string, fileId: string, status: FileItem["status"]): Promise<boolean> {
    return this.db.run("UPDATE files SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?", status, nowIso(), fileId, userId).changes > 0;
  }

  async softDeleteFile(userId: string, fileId: string): Promise<void> {
    const now = nowIso();
    const { changes } = this.db.run(
      "UPDATE files SET deleted_at = ?, trash_root_id = id, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
      now, now, fileId, userId
    );
    if (changes === 0) throw new AppError(ErrorCode.NOT_FOUND, "File not found", 404);
  }

  /** Restores a file the user trashed directly. If its folder is no longer active it lands in the root. */
  async restoreFile(userId: string, fileId: string): Promise<FileItem> {
    return this.db.transaction(() => {
      const file = this.db.get<FileRow>("SELECT * FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL", fileId, userId);
      if (!file) throw new AppError(ErrorCode.NOT_FOUND, "File not found in trash", 404);
      if (file.trash_root_id !== file.id) {
        throw new AppError(ErrorCode.CONFLICT, "This file was deleted together with its folder — restore the folder instead", 409);
      }
      const folderActive = file.folder_id
        ? this.db.get<{ id: string }>("SELECT id FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NULL", file.folder_id, userId)
        : undefined;
      this.db.run(
        "UPDATE files SET deleted_at = NULL, trash_root_id = NULL, folder_id = ?, updated_at = ? WHERE id = ?",
        folderActive ? file.folder_id : null, nowIso(), fileId
      );
      return toFile(this.db.get<FileRow>(`${SELECT_FILE} WHERE f.id = ?`, fileId)!);
    });
  }

  async toggleFavorite(userId: string, fileId: string): Promise<boolean> {
    return this.db.transaction(() => {
      const file = this.db.get<{ id: string }>("SELECT id FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL", fileId, userId);
      if (!file) throw new AppError(ErrorCode.NOT_FOUND, "File not found", 404);
      const removed = this.db.run("DELETE FROM favorites WHERE user_id = ? AND file_id = ?", userId, fileId).changes > 0;
      if (removed) return false;
      this.db.run("INSERT INTO favorites (user_id, file_id, created_at) VALUES (?, ?, ?)", userId, fileId, nowIso());
      return true;
    });
  }

  // ─── Permanent deletion ────────────────────────────────────────────────────

  /**
   * Plans permanent deletion of trash roots. `rootId` = a file or folder id that the
   * user trashed directly; omit it to empty the whole trash.
   */
  async planPurge(userId: string, rootId?: string): Promise<PurgePlan> {
    if (rootId) {
      const isRoot =
        this.db.get<{ id: string }>("SELECT id FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL AND trash_root_id = id", rootId, userId) ??
        this.db.get<{ id: string }>("SELECT id FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL AND trash_root_id = id", rootId, userId);
      if (!isRoot) throw new AppError(ErrorCode.NOT_FOUND, "Item not found in trash", 404);
    }

    const scope = rootId ? "AND trash_root_id = ?" : "";
    const scopeParams = rootId ? [rootId] : [];
    const fileIds = this.db
      .all<{ id: string }>(`SELECT id FROM files WHERE user_id = ? AND deleted_at IS NOT NULL ${scope}`, userId, ...scopeParams)
      .map(r => r.id);
    const folderIds = this.db
      .all<{ id: string }>(`SELECT id FROM folders WHERE user_id = ? AND deleted_at IS NOT NULL ${scope}`, userId, ...scopeParams)
      .map(r => r.id);

    const objects: TelegramObject[] = [];
    for (let i = 0; i < fileIds.length; i += 500) {
      const chunk = fileIds.slice(i, i + 500);
      const rows = this.db.all<{
        file_id: string; peer_id: string; message_id: number; document_id: string;
        access_hash: string; file_reference: string; dc_id: number; created_at: string;
      }>(`SELECT * FROM telegram_objects WHERE file_id IN (${chunk.map(() => "?").join(",")})`, ...chunk);
      for (const r of rows) {
        objects.push({
          fileId: r.file_id, peerId: r.peer_id, messageId: r.message_id, documentId: r.document_id,
          accessHash: r.access_hash, fileReference: r.file_reference, dcId: r.dc_id, createdAt: r.created_at
        });
      }
    }
    return { fileIds, folderIds, objects };
  }

  /** Deletes the planned rows — only those still in the trash (a concurrent restore wins). */
  async executePurge(userId: string, plan: PurgePlan): Promise<{ files: number; folders: number }> {
    return this.db.transaction(() => {
      let files = 0;
      let folders = 0;
      for (let i = 0; i < plan.fileIds.length; i += 500) {
        const chunk = plan.fileIds.slice(i, i + 500);
        files += this.db.run(
          `DELETE FROM files WHERE user_id = ? AND deleted_at IS NOT NULL AND id IN (${chunk.map(() => "?").join(",")})`, userId, ...chunk
        ).changes;
      }
      for (let i = 0; i < plan.folderIds.length; i += 500) {
        const chunk = plan.folderIds.slice(i, i + 500);
        folders += this.db.run(
          `DELETE FROM folders WHERE user_id = ? AND deleted_at IS NOT NULL AND id IN (${chunk.map(() => "?").join(",")})`, userId, ...chunk
        ).changes;
      }
      return { files, folders };
    });
  }

  /** Removes a file row outright (e.g. a cancelled upload that never reached storage). */
  async deleteFileRow(userId: string, fileId: string): Promise<void> {
    this.db.run("DELETE FROM files WHERE id = ? AND user_id = ?", fileId, userId);
  }

  async getStorageAnalytics(userId: string): Promise<StorageAnalytics> {
    const files = this.db.get<{ n: number; bytes: number | null }>(
      "SELECT COUNT(*) AS n, SUM(size_bytes) AS bytes FROM files WHERE user_id = ? AND deleted_at IS NULL", userId
    )!;
    const folders = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM folders WHERE user_id = ? AND deleted_at IS NULL", userId)!;
    const usedBytes = files.bytes ?? 0;

    const formatBytes = (bytes: number): string => {
      if (bytes === 0) return "0 B";
      const sizes = ["B", "KB", "MB", "GB", "TB"];
      const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
      return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${sizes[i]}`;
    };

    return {
      totalFiles: files.n,
      totalFolders: folders.n,
      usedBytes,
      formattedUsed: formatBytes(usedBytes),
      status: "active"
    };
  }
}
