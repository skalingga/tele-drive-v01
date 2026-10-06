import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Database,
  UserRepository,
  FolderRepository,
  FileRepository,
  JobRepository,
  TelegramObjectRepository
} from "../../packages/database/dist/index.js";

function setup() {
  const db = new Database(":memory:");
  return {
    db,
    users: new UserRepository(db),
    folders: new FolderRepository(db),
    files: new FileRepository(db),
    jobs: new JobRepository(db),
    objects: new TelegramObjectRepository(db)
  };
}

async function makeUser(users, tgId = "1") {
  return users.upsertFromTelegram({ telegramUserId: tgId, displayName: "U", username: null, sessionEnc: "v1.x.y.z" });
}

test("Users: QR re-login reuses the account; sessions validate, expire and revoke", async () => {
  const { users, db } = setup();
  const first = await makeUser(users, "42");
  const again = await users.upsertFromTelegram({ telegramUserId: "42", displayName: "Renamed", username: "r", sessionEnc: "v1.new" });
  assert.equal(again.id, first.id);
  assert.equal(again.displayName, "Renamed");
  assert.equal(await users.getSessionEnc(first.id), "v1.new");

  const { token, session } = await users.createSession(first.id);
  assert.equal((await users.validateSession(token)).id, first.id);
  assert.notEqual(session.tokenHash, token, "only the hash is stored");
  assert.equal(await users.validateSession("wrong"), null);

  db.run("UPDATE sessions SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), session.id);
  assert.equal(await users.validateSession(token), null, "expired session rejected");

  const second = await users.createSession(first.id);
  await users.markTelegramRevoked(first.id);
  assert.equal(await users.validateSession(second.token), null, "revoking Telegram ends all app sessions");
  assert.equal(await users.getSessionEnc(first.id), null);
});

test("Database file survives reopen (durability) and is migrated once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "td-db-"));
  const file = path.join(dir, "t.sqlite");
  let db = new Database(file);
  const user = await makeUser(new UserRepository(db));
  await new FolderRepository(db).createFolder(user.id, "Keep");
  db.close();

  db = new Database(file);
  const listed = await new FolderRepository(db).listFolders(user.id);
  assert.deepEqual(listed.items.map(f => f.name), ["Keep"]);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Folders: cycles are impossible and breadcrumbs are bounded", async () => {
  const { users, folders } = setup();
  const u = await makeUser(users);
  const a = await folders.createFolder(u.id, "A");
  const b = await folders.createFolder(u.id, "B", a.id);
  const c = await folders.createFolder(u.id, "C", b.id);

  await assert.rejects(folders.moveFolder(u.id, a.id, a.id), /itself/);
  await assert.rejects(folders.moveFolder(u.id, a.id, c.id), /itself/);
  await folders.moveFolder(u.id, c.id, null);
  assert.equal((await folders.getFolderById(u.id, c.id)).parentId, null);

  const crumbs = await folders.getBreadcrumbs(u.id, b.id);
  assert.deepEqual(crumbs.map(x => x.name), ["My Drive", "A", "B"]);
});

test("Folders: rename + move is atomic (a failing move leaves the name unchanged)", async () => {
  const { users, folders } = setup();
  const u = await makeUser(users);
  const a = await folders.createFolder(u.id, "A");
  await assert.rejects(folders.updateFolder(u.id, a.id, { name: "Renamed", parentId: a.id }));
  assert.equal((await folders.getFolderById(u.id, a.id)).name, "A");
});

test("Trash: restoring a folder only restores what was trashed with it", async () => {
  const { users, folders, files } = setup();
  const u = await makeUser(users);
  const dir = await folders.createFolder(u.id, "Dir");
  const sub = await folders.createFolder(u.id, "Sub", dir.id);
  const keep = await files.createFile(u.id, { name: "keep.txt", mimeType: "text/plain", sizeBytes: 1, folderId: sub.id });
  const separately = await files.createFile(u.id, { name: "gone.txt", mimeType: "text/plain", sizeBytes: 1, folderId: dir.id });

  await files.softDeleteFile(u.id, separately.id); // user deletes this one first
  await folders.softDeleteFolder(u.id, dir.id);

  const trash = await files.listFiles(u.id, { filter: "trash" });
  assert.deepEqual(trash.items.map(f => f.id), [separately.id], "files inside a trashed folder are not listed separately");
  await assert.rejects(files.restoreFile(u.id, keep.id), /restore the folder/);

  await folders.restoreFolder(u.id, dir.id);
  assert.equal((await files.getFileById(u.id, keep.id)).deletedAt, null, "nested content restored");
  assert.notEqual((await files.getFileById(u.id, separately.id)).deletedAt, null, "separately trashed file stays in trash");
});

test("Trash: restoring an item whose parent is gone puts it in the root; name clashes get a suffix", async () => {
  const { users, folders, files } = setup();
  const u = await makeUser(users);
  const parent = await folders.createFolder(u.id, "Parent");
  const child = await folders.createFolder(u.id, "Child", parent.id);
  const f = await files.createFile(u.id, { name: "f.txt", mimeType: "text/plain", sizeBytes: 1, folderId: parent.id });

  await folders.softDeleteFolder(u.id, child.id);
  await files.softDeleteFile(u.id, f.id);
  await folders.softDeleteFolder(u.id, parent.id);
  await folders.createFolder(u.id, "Child"); // occupies the name in root

  const restored = await folders.restoreFolder(u.id, child.id);
  assert.equal(restored.parentId, null);
  assert.equal(restored.name, "Child (1)");
  assert.equal((await files.restoreFile(u.id, f.id)).folderId, null);
});

test("Purge: plan collects the trash root's subtree and its storage objects", async () => {
  const { users, folders, files, objects } = setup();
  const u = await makeUser(users);
  const dir = await folders.createFolder(u.id, "Dir");
  const f = await files.createFile(u.id, { name: "a", mimeType: "x/y", sizeBytes: 1, folderId: dir.id, status: "ready" });
  await objects.saveObject({ fileId: f.id, peerId: "p", messageId: 9, documentId: "d", accessHash: "h", fileReference: "r", dcId: 2, createdAt: new Date().toISOString() });

  await assert.rejects(files.planPurge(u.id, dir.id), /not found in trash/, "active items cannot be purged");
  await folders.softDeleteFolder(u.id, dir.id);
  const plan = await files.planPurge(u.id, dir.id);
  assert.deepEqual(plan.fileIds, [f.id]);
  assert.deepEqual(plan.objects.map(o => o.messageId), [9]);
  assert.deepEqual(await files.executePurge(u.id, plan), { files: 1, folders: 1 });
  assert.equal(await objects.getByFileId(u.id, f.id), null, "storage mapping removed by cascade");
});

test("Pagination: keyset cursor is stable while rows are inserted and deleted", async () => {
  const { users, files } = setup();
  const u = await makeUser(users);
  const created = [];
  for (let i = 0; i < 10; i++) {
    created.push(await files.createFile(u.id, { name: `f${String(i).padStart(2, "0")}`, mimeType: "text/plain", sizeBytes: i }));
  }
  const page1 = await files.listFiles(u.id, { limit: 4, sort: "name_asc" });
  assert.deepEqual(page1.items.map(f => f.name), ["f00", "f01", "f02", "f03"]);

  // Concurrent changes: the cursor row itself is deleted and an earlier row is inserted.
  await files.softDeleteFile(u.id, created[3].id);
  await files.createFile(u.id, { name: "a-new", mimeType: "text/plain", sizeBytes: 1 });

  const page2 = await files.listFiles(u.id, { limit: 4, sort: "name_asc", cursor: page1.nextCursor });
  assert.deepEqual(page2.items.map(f => f.name), ["f04", "f05", "f06", "f07"], "no duplicates, no restart from the beginning");

  const bySize = await files.listFiles(u.id, { limit: 3, sort: "size_desc" });
  const next = await files.listFiles(u.id, { limit: 3, sort: "size_desc", cursor: bySize.nextCursor });
  assert.deepEqual([...bySize.items, ...next.items].map(f => f.sizeBytes), [9, 8, 7, 6, 5, 4]);
});

test("Type filter 'other' excludes known categories; search escapes LIKE wildcards", async () => {
  const { users, files } = setup();
  const u = await makeUser(users);
  await files.createFile(u.id, { name: "pic.png", mimeType: "image/png", sizeBytes: 1 });
  await files.createFile(u.id, { name: "100%_done.bin", mimeType: "application/octet-stream", sizeBytes: 1 });
  const other = await files.listFiles(u.id, { type: "other" });
  assert.deepEqual(other.items.map(f => f.name), ["100%_done.bin"]);
  assert.equal((await files.searchFiles(u.id, "%")).items.length, 1);
  assert.equal((await files.searchFiles(u.id, "_")).items.length, 1);
  assert.equal((await files.searchFiles(u.id, "PIC")).items.length, 1, "case-insensitive");
});

test("Jobs: per-user scoping, claiming, cancellation and crash recovery", async () => {
  const { users, files, jobs } = setup();
  const u1 = await makeUser(users, "1");
  const u2 = await makeUser(users, "2");
  const f1 = await files.createFile(u1.id, { name: "a", mimeType: "x/y", sizeBytes: 5 });
  const f2 = await files.createFile(u1.id, { name: "b", mimeType: "x/y", sizeBytes: 5 });
  const j1 = await jobs.createJob(u1.id, f1.id, 5, "/tmp/a");
  const j2 = await jobs.createJob(u1.id, f2.id, 5, "/tmp/b");

  assert.equal(await jobs.getJobById(u2.id, j1.id), null, "jobs are user-scoped");
  assert.equal((await jobs.cancelQueued(u2.id, j1.id)).cancelled, false);

  const claimed = await jobs.claimNext(1);
  assert.equal(claimed.id, j1.id);
  assert.equal(claimed.attempts, 1);
  assert.equal(await jobs.claimNext(1), null, "per-user concurrency limit respected");

  assert.equal(await jobs.requeueInterrupted(), 1, "processing job re-queued after restart");
  assert.deepEqual([...(await jobs.liveTempPaths())].sort(), ["/tmp/a", "/tmp/b"]);

  const cancel = await jobs.cancelQueued(u1.id, j2.id);
  assert.equal(cancel.cancelled, true);
  assert.equal(cancel.tempPath, "/tmp/b");
});
