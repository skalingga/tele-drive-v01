import crypto from "node:crypto";
import { type Folder, AppError, ErrorCode, encodeCursor, decodeCursor } from "@teledrive/shared";
import { Database, nowIso } from "./db.js";

interface FolderRow {
  id: string;
  user_id: string;
  parent_id: string | null;
  name: string;
  deleted_at: string | null;
  trash_root_id: string | null;
  created_at: string;
  updated_at: string;
}

export function toFolder(row: FolderRow): Folder {
  return {
    id: row.id,
    userId: row.user_id,
    parentId: row.parent_id,
    name: row.name,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** Defensive bound when walking parent chains. */
const MAX_DEPTH = 256;

export interface ListFoldersOptions {
  parentId?: string | null;
  trash?: boolean;
  cursor?: string;
  limit?: number;
}

export class FolderRepository {
  constructor(private db: Database) {}

  private getActive(userId: string, folderId: string): FolderRow | undefined {
    return this.db.get<FolderRow>("SELECT * FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NULL", folderId, userId);
  }

  private requireActive(userId: string, folderId: string, message = "Folder not found"): FolderRow {
    const folder = this.getActive(userId, folderId);
    if (!folder) throw new AppError(ErrorCode.NOT_FOUND, message, 404);
    return folder;
  }

  private assertNameFree(userId: string, parentId: string | null, name: string, exceptId?: string): void {
    const conflict = this.db.get<{ id: string }>(
      `SELECT id FROM folders
       WHERE user_id = ? AND parent_id IS ? AND deleted_at IS NULL AND name = ? COLLATE NOCASE AND id IS NOT ?`,
      userId, parentId, name, exceptId ?? null
    );
    if (conflict) {
      throw new AppError(ErrorCode.CONFLICT, "A folder with this name already exists in this location", 409);
    }
  }

  /** Picks "name", "name (1)", "name (2)"… — used when restoring into an occupied location. */
  private freeName(userId: string, parentId: string | null, name: string, exceptId: string): string {
    for (let i = 0; i < 1000; i++) {
      const candidate = i === 0 ? name : `${name} (${i})`;
      const taken = this.db.get<{ id: string }>(
        `SELECT id FROM folders WHERE user_id = ? AND parent_id IS ? AND deleted_at IS NULL AND name = ? COLLATE NOCASE AND id != ?`,
        userId, parentId, candidate, exceptId
      );
      if (!taken) return candidate;
    }
    return `${name} (${crypto.randomUUID().slice(0, 8)})`;
  }

  async createFolder(userId: string, name: string, parentId: string | null = null): Promise<Folder> {
    return this.db.transaction(() => {
      if (parentId) this.requireActive(userId, parentId, "Parent folder not found");
      const cleanName = name.trim();
      this.assertNameFree(userId, parentId, cleanName);

      const now = nowIso();
      const id = `fld_${crypto.randomUUID()}`;
      this.db.run(
        "INSERT INTO folders (id, user_id, parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        id, userId, parentId, cleanName, now, now
      );
      return toFolder(this.db.get<FolderRow>("SELECT * FROM folders WHERE id = ?", id)!);
    });
  }

  async getFolderById(userId: string, folderId: string): Promise<Folder | null> {
    const row = this.db.get<FolderRow>("SELECT * FROM folders WHERE id = ? AND user_id = ?", folderId, userId);
    return row ? toFolder(row) : null;
  }

  /**
   * Lists active children of a folder, or the user's trash (only the items the user
   * deleted directly — their contents come back with them on restore).
   */
  async listFolders(userId: string, options: ListFoldersOptions = {}): Promise<{ items: Folder[]; nextCursor: string | null; total: number }> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
    const where: string[] = ["user_id = ?"];
    const params: (string | number | null)[] = [userId];

    if (options.trash) {
      where.push("deleted_at IS NOT NULL", "trash_root_id = id");
    } else {
      const parentId = options.parentId ?? null;
      if (parentId) this.requireActive(userId, parentId);
      where.push("deleted_at IS NULL", "parent_id IS ?");
      params.push(parentId);
    }

    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM folders WHERE ${where.join(" AND ")}`, ...params)!.n;

    const cursor = options.cursor ? decodeCursor(options.cursor) : null;
    if (options.cursor && !cursor) throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid cursor", 400);
    if (cursor) {
      where.push("(name COLLATE NOCASE > ? OR (name = ? COLLATE NOCASE AND id > ?))");
      params.push(String(cursor.v), String(cursor.v), cursor.id);
    }

    const rows = this.db.all<FolderRow>(
      `SELECT * FROM folders WHERE ${where.join(" AND ")} ORDER BY name COLLATE NOCASE ASC, id ASC LIMIT ?`,
      ...params, limit + 1
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toFolder),
      nextCursor: hasMore && last ? encodeCursor({ v: last.name, id: last.id }) : null,
      total
    };
  }

  /** Rename and/or move atomically. Rejects moving a folder into itself or a descendant. */
  async updateFolder(userId: string, folderId: string, updates: { name?: string; parentId?: string | null }): Promise<Folder> {
    return this.db.transaction(() => {
      const folder = this.requireActive(userId, folderId);
      const nextName = updates.name !== undefined ? updates.name.trim() : folder.name;
      const nextParent = updates.parentId !== undefined ? updates.parentId : folder.parent_id;

      if (updates.parentId !== undefined && nextParent !== null) {
        this.requireActive(userId, nextParent, "Destination folder not found");
        this.assertNotDescendant(userId, folderId, nextParent);
      }
      this.assertNameFree(userId, nextParent, nextName, folderId);

      this.db.run(
        "UPDATE folders SET name = ?, parent_id = ?, updated_at = ? WHERE id = ? AND user_id = ?",
        nextName, nextParent, nowIso(), folderId, userId
      );
      return toFolder(this.db.get<FolderRow>("SELECT * FROM folders WHERE id = ?", folderId)!);
    });
  }

  async renameFolder(userId: string, folderId: string, newName: string): Promise<Folder> {
    return this.updateFolder(userId, folderId, { name: newName });
  }

  async moveFolder(userId: string, folderId: string, parentId: string | null): Promise<Folder> {
    return this.updateFolder(userId, folderId, { parentId });
  }

  /** Walks up from `targetId`; if we meet `folderId` the move would create a cycle. */
  private assertNotDescendant(userId: string, folderId: string, targetId: string): void {
    let currentId: string | null = targetId;
    const seen = new Set<string>();
    while (currentId) {
      if (currentId === folderId) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "A folder cannot be moved into itself or one of its subfolders", 400);
      }
      if (seen.has(currentId) || seen.size > MAX_DEPTH) break;
      seen.add(currentId);
      const row: { parent_id: string | null } | undefined = this.db.get<{ parent_id: string | null }>(
        "SELECT parent_id FROM folders WHERE id = ? AND user_id = ?", currentId, userId
      );
      currentId = row?.parent_id ?? null;
    }
  }

  /** Ids of the folder and every active descendant (recursive CTE, cycle-safe via UNION). */
  private activeSubtreeIds(userId: string, folderId: string): string[] {
    return this.db.all<{ id: string }>(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NULL
         UNION
         SELECT f.id FROM folders f JOIN tree t ON f.parent_id = t.id
         WHERE f.user_id = ? AND f.deleted_at IS NULL
       )
       SELECT id FROM tree`,
      folderId, userId, userId
    ).map(r => r.id);
  }

  async softDeleteFolder(userId: string, folderId: string): Promise<void> {
    this.db.transaction(() => {
      this.requireActive(userId, folderId);
      const now = nowIso();
      const ids = this.activeSubtreeIds(userId, folderId);
      const placeholders = ids.map(() => "?").join(",");
      this.db.run(
        `UPDATE folders SET deleted_at = ?, trash_root_id = ?, updated_at = ? WHERE user_id = ? AND id IN (${placeholders})`,
        now, folderId, now, userId, ...ids
      );
      this.db.run(
        `UPDATE files SET deleted_at = ?, trash_root_id = ?, updated_at = ?
         WHERE user_id = ? AND deleted_at IS NULL AND folder_id IN (${placeholders})`,
        now, folderId, now, userId, ...ids
      );
    });
  }

  /**
   * Restores a folder the user deleted directly, together with exactly the contents
   * that were trashed with it (items trashed separately before stay in the trash).
   * If the original parent is gone or trashed, the folder is restored to the root.
   */
  async restoreFolder(userId: string, folderId: string): Promise<Folder> {
    return this.db.transaction(() => {
      const folder = this.db.get<FolderRow>(
        "SELECT * FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL", folderId, userId
      );
      if (!folder) throw new AppError(ErrorCode.NOT_FOUND, "Folder not found in trash", 404);
      if (folder.trash_root_id !== folder.id) {
        throw new AppError(ErrorCode.CONFLICT, "This folder was deleted together with a parent folder — restore that folder instead", 409);
      }

      const parentActive = folder.parent_id ? this.getActive(userId, folder.parent_id) : undefined;
      const parentId = parentActive ? folder.parent_id : null;
      const name = this.freeName(userId, parentId, folder.name, folder.id);
      const now = nowIso();

      this.db.run(
        "UPDATE folders SET deleted_at = NULL, trash_root_id = NULL, updated_at = ? WHERE user_id = ? AND trash_root_id = ?",
        now, userId, folderId
      );
      this.db.run(
        "UPDATE files SET deleted_at = NULL, trash_root_id = NULL, updated_at = ? WHERE user_id = ? AND trash_root_id = ?",
        now, userId, folderId
      );
      this.db.run("UPDATE folders SET parent_id = ?, name = ? WHERE id = ?", parentId, name, folderId);
      return toFolder(this.db.get<FolderRow>("SELECT * FROM folders WHERE id = ?", folderId)!);
    });
  }

  async getBreadcrumbs(userId: string, folderId: string | null): Promise<{ id: string | null; name: string }[]> {
    const crumbs: { id: string | null; name: string }[] = [{ id: null, name: "My Drive" }];
    if (!folderId) return crumbs;

    const chain: { id: string; name: string }[] = [];
    const seen = new Set<string>();
    let currentId: string | null = folderId;
    while (currentId && !seen.has(currentId) && seen.size < MAX_DEPTH) {
      seen.add(currentId);
      const row: FolderRow | undefined = this.db.get<FolderRow>("SELECT * FROM folders WHERE id = ? AND user_id = ?", currentId, userId);
      if (!row) break;
      chain.unshift({ id: row.id, name: row.name });
      currentId = row.parent_id;
    }
    return [...crumbs, ...chain];
  }
}
