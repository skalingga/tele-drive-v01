/**
 * Critical user journey through the real HTTP API (QR login → drive operations → logout).
 * Runs against its own server instance — see tests/helpers/harness.js.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startHarness, waitForJob } from "../helpers/harness.js";

let h;
let client;
let parentId;
let childId;
let fileId;
const content = Buffer.from("Hello TeleDrive! ".repeat(4096)); // 69,632 bytes

before(async () => {
  h = await startHarness();
  client = h.client();
});
after(async () => h.close());

test("E2E 01: QR login (with 2FA) issues an httpOnly SameSite=Strict session cookie", async () => {
  const start = await client.post("/api/auth/qr");
  assert.equal(start.status, 201);
  assert.ok(start.setCookies.some(c => c.startsWith("td_qr=") && /HttpOnly/i.test(c)), "attempt bound to browser cookie");

  const waiting = await client.get("/api/auth/qr");
  assert.equal(waiting.data.data.state.status, "waiting");
  assert.match(waiting.data.data.qrSvg, /^<svg/, "QR rendered server-side as SVG");

  h.qrLogin.scan({ telegramUserId: "777000111", displayName: "Budi", username: "budi" }, { needsPassword: true });
  const pw = await client.get("/api/auth/qr");
  assert.equal(pw.data.data.state.status, "password_required");

  await client.post("/api/auth/qr/password", { json: { password: "wrong" } });
  assert.equal((await client.get("/api/auth/qr")).data.data.state.passwordError, "Password 2FA salah. Coba lagi.");

  await client.post("/api/auth/qr/password", { json: { password: "correct horse" } });
  const done = await client.get("/api/auth/qr");
  assert.equal(done.status, 200);
  assert.equal(done.data.data.state.status, "success");
  assert.equal(done.data.data.user.displayName, "Budi");
  assert.equal(JSON.stringify(done.data).includes("session"), false, "no session secrets in the body");

  const sessionCookie = done.setCookies.find(c => c.startsWith("td_session="));
  assert.ok(sessionCookie, "session cookie set");
  assert.match(sessionCookie, /HttpOnly/i);
  assert.match(sessionCookie, /SameSite=Strict/i);

  const me = await client.get("/api/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.data.telegramUserId, "777000111");
});

test("E2E 02: create a folder and a sub-folder; duplicate names are rejected", async () => {
  const parent = await client.post("/api/folders", { json: { name: "Projects" } });
  assert.equal(parent.status, 201);
  parentId = parent.data.data.id;

  const child = await client.post("/api/folders", { json: { name: "Design", parent_id: parentId } });
  assert.equal(child.status, 201);
  childId = child.data.data.id;

  const dup = await client.post("/api/folders", { json: { name: "projects" } });
  assert.equal(dup.status, 409);
});

test("E2E 03: upload is accepted (202), transferred by the worker, then ready", async () => {
  const res = await client.upload("laporan-α.txt", content, { mimeType: "text/plain", folderId: parentId });
  assert.equal(res.status, 202);
  assert.equal(res.data.data.file.status, "pending");
  assert.equal(res.data.data.file.name, "laporan-α.txt", "UTF-8 filename preserved");
  fileId = res.data.data.file.id;

  const job = await waitForJob(client, res.data.data.job.id);
  assert.equal(job.status, "completed");
  assert.equal(job.progressBytes, content.length);

  const file = await client.get(`/api/files/${fileId}`);
  assert.equal(file.data.data.status, "ready");
});

test("E2E 04: list files in folder with breadcrumbs", async () => {
  const files = await client.get(`/api/files?folder_id=${parentId}`);
  assert.equal(files.status, 200);
  assert.equal(files.data.data.length, 1);
  assert.equal(files.data.meta.total, 1);
  assert.equal(files.data.meta.next_cursor, null);

  const folders = await client.get(`/api/folders?parent_id=${childId}`);
  assert.deepEqual(folders.data.meta.breadcrumbs.map(b => b.name), ["My Drive", "Projects", "Design"]);
});

test("E2E 05: download — full body and byte ranges (incl. suffix and unsatisfiable)", async () => {
  const full = await client.get(`/api/files/${fileId}/content`);
  assert.equal(full.status, 200);
  assert.ok(full.data.equals(content));
  assert.equal(full.headers.get("accept-ranges"), "bytes");

  const part = await client.get(`/api/files/${fileId}/content`, { headers: { Range: "bytes=100-199" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 100-199/${content.length}`);
  assert.ok(part.data.equals(content.subarray(100, 200)));

  const suffix = await client.get(`/api/files/${fileId}/content`, { headers: { Range: "bytes=-5" } });
  assert.equal(suffix.status, 206);
  assert.ok(suffix.data.equals(content.subarray(content.length - 5)));

  const beyond = await client.get(`/api/files/${fileId}/content`, { headers: { Range: "bytes=69000-99999999" } });
  assert.equal(beyond.status, 206, "end is clamped instead of hanging");
  assert.ok(beyond.data.equals(content.subarray(69000)));

  const unsatisfiable = await client.get(`/api/files/${fileId}/content`, { headers: { Range: `bytes=${content.length}-` } });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get("content-range"), `bytes */${content.length}`);
});

test("E2E 06: rename, move, favorite", async () => {
  const renamed = await client.patch(`/api/files/${fileId}`, { json: { name: "final.txt" } });
  assert.equal(renamed.data.data.name, "final.txt");

  const moved = await client.patch(`/api/files/${fileId}`, { json: { folder_id: childId } });
  assert.equal(moved.data.data.folderId, childId);

  const fav = await client.post(`/api/files/${fileId}/favorite`);
  assert.equal(fav.data.data.isFavorite, true);
  const favs = await client.get("/api/files?filter=favorites");
  assert.deepEqual(favs.data.data.map(f => f.id), [fileId]);
});

test("E2E 07: search treats % and _ literally", async () => {
  const hit = await client.get("/api/search?q=FINAL");
  assert.deepEqual(hit.data.data.map(f => f.id), [fileId]);
  const wildcard = await client.get("/api/search?q=%25");
  assert.equal(wildcard.data.data.length, 0);
});

test("E2E 08: cursor pagination walks every file exactly once", async () => {
  for (let i = 0; i < 7; i++) await client.uploadAndWait(`page-${i}.bin`, Buffer.from(`file ${i}`));
  const seen = [];
  let cursor = null;
  do {
    const res = await client.get(`/api/files?limit=3&sort=name_asc${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(res.status, 200);
    seen.push(...res.data.data.map(f => f.name));
    cursor = res.data.meta.next_cursor;
  } while (cursor);
  assert.deepEqual(seen, [...seen].sort((a, b) => a.localeCompare(b)));
  assert.equal(new Set(seen).size, 7);
});

test("E2E 09: trash and restore a folder brings its contents back", async () => {
  assert.equal((await client.del(`/api/folders/${parentId}`)).status, 200);
  assert.equal((await client.get(`/api/files/${fileId}/content`)).status, 404, "trashed content not served");

  const trashFolders = await client.get("/api/folders?filter=trash");
  assert.deepEqual(trashFolders.data.data.map(f => f.id), [parentId], "only the trashed root is listed");

  assert.equal((await client.post(`/api/folders/${parentId}/restore`)).status, 200);
  const file = await client.get(`/api/files/${fileId}`);
  assert.equal(file.data.data.deletedAt, null);
});

test("E2E 10: permanent delete removes the object from storage", async () => {
  const { file } = await client.uploadAndWait("temp.bin", Buffer.from("bye"));
  await client.del(`/api/files/${file.id}`);
  const adapter = h.adapters.get((await client.get("/api/me")).data.data.id);
  const stored = await h.telegramObjects.getByFileId(file.userId, file.id);
  assert.equal(await adapter.exists(stored), true);

  const purge = await client.del(`/api/trash/${file.id}`);
  assert.equal(purge.status, 200);
  assert.equal(await adapter.exists(stored), false, "Telegram message deleted");
  assert.equal((await client.get(`/api/files/${file.id}`)).status, 404);
});

test("E2E 11: storage analytics and health", async () => {
  const storage = await client.get("/api/storage");
  assert.equal(storage.data.data.totalFiles, 8);
  assert.equal(storage.data.data.totalFolders, 2);
  const health = await client.get("/api/health");
  assert.equal(health.data.data.status, "ok");
});

test("E2E 12: logout revokes the session and the Telegram credential", async () => {
  const me = (await client.get("/api/me")).data.data;
  const out = await client.post("/api/auth/logout");
  assert.equal(out.status, 200);
  assert.equal((await client.get("/api/me")).status, 401);
  assert.equal(await h.users.getSessionEnc(me.id), null, "encrypted Telegram session wiped");
});
