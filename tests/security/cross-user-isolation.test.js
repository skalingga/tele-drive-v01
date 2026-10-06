/**
 * Security gate (row level): every repository method is scoped to the calling user,
 * even when another user's ids are known.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  Database,
  UserRepository,
  FolderRepository,
  FileRepository,
  TelegramObjectRepository
} from "../../packages/database/dist/index.js";

test("Security gate: repositories never act on another user's rows", async () => {
  const db = new Database(":memory:");
  const users = new UserRepository(db);
  const folders = new FolderRepository(db);
  const files = new FileRepository(db);
  const objects = new TelegramObjectRepository(db);

  const a = await users.upsertFromTelegram({ telegramUserId: "1", displayName: "A", username: null, sessionEnc: "x" });
  const b = await users.upsertFromTelegram({ telegramUserId: "2", displayName: "B", username: null, sessionEnc: "y" });

  const folder = await folders.createFolder(a.id, "A-private");
  const file = await files.createFile(a.id, { name: "a.txt", mimeType: "text/plain", sizeBytes: 1, folderId: folder.id, status: "ready" });
  await objects.saveObject({ fileId: file.id, peerId: "100", messageId: 1, documentId: "d", accessHash: "h", fileReference: "r", dcId: 2, createdAt: new Date().toISOString() });

  // Reads
  assert.equal(await files.getFileById(b.id, file.id), null);
  assert.equal(await folders.getFolderById(b.id, folder.id), null);
  assert.equal(await objects.getByFileId(b.id, file.id), null);
  assert.equal((await files.listFiles(b.id, { filter: "recent" })).items.length, 0);
  assert.equal((await files.searchFiles(b.id, "a")).items.length, 0);
  await assert.rejects(files.listFiles(b.id, { folderId: folder.id }), /not found/i);
  await assert.rejects(folders.listFolders(b.id, { parentId: folder.id }), /not found/i);

  // Writes
  await assert.rejects(files.updateFile(b.id, file.id, { name: "x" }), /not found/i);
  await assert.rejects(files.updateFile(a.id, file.id, { folderId: (await folders.createFolder(b.id, "B")).id }), /not found/i, "cannot move into someone else's folder");
  await assert.rejects(files.softDeleteFile(b.id, file.id), /not found/i);
  await assert.rejects(files.toggleFavorite(b.id, file.id), /not found/i);
  await assert.rejects(folders.renameFolder(b.id, folder.id, "x"), /not found/i);
  await assert.rejects(folders.softDeleteFolder(b.id, folder.id), /not found/i);
  await assert.rejects(folders.createFolder(b.id, "child", folder.id), /not found/i);
  await objects.updateFileReference(b.id, file.id, "hijacked");
  assert.equal((await objects.getByFileId(a.id, file.id)).fileReference, "r");

  // Trash / purge
  await files.softDeleteFile(a.id, file.id);
  await assert.rejects(files.restoreFile(b.id, file.id), /not found/i);
  await assert.rejects(files.planPurge(b.id, file.id), /not found/i);
  const emptyB = await files.planPurge(b.id);
  assert.equal(emptyB.fileIds.length, 0, "emptying B's trash never touches A's files");

  // Credentials are per user and never cross over
  assert.equal(await users.getSessionEnc(a.id), "x");
  assert.equal(await users.getSessionEnc(b.id), "y");
});
