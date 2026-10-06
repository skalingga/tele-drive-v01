/**
 * API security audit: cross-user IDOR, DoS regressions, CSRF, content-type safety,
 * input validation. Each finding from the 2026-10 review has a regression test here.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "../helpers/harness.js";

let h;
let a; // owner
let b; // attacker
let fileA;
let folderA;
let jobA;
let htmlFile;

before(async () => {
  h = await startHarness();
  a = await h.login("100");
  b = await h.login("200");

  folderA = (await a.client.post("/api/folders", { json: { name: "Private" } })).data.data;
  const up = await a.client.uploadAndWait("secret.txt", Buffer.from("top secret"), { mimeType: "text/plain", folderId: folderA.id });
  fileA = up.file;
  jobA = up.job;
  htmlFile = (await a.client.uploadAndWait("evil.html", Buffer.from("<script>alert(1)</script>"), { mimeType: "text/html" })).file;
});
after(async () => h.close());

test("IDOR: user B cannot read, stream, modify or delete user A's file", async () => {
  const c = b.client;
  assert.equal((await c.get(`/api/files/${fileA.id}`)).status, 404);
  assert.equal((await c.get(`/api/files/${fileA.id}/content`)).status, 404);
  assert.equal((await c.patch(`/api/files/${fileA.id}`, { json: { name: "pwned.txt" } })).status, 404);
  assert.equal((await c.patch(`/api/files/${fileA.id}`, { json: { folder_id: null } })).status, 404);
  assert.equal((await c.post(`/api/files/${fileA.id}/favorite`)).status, 404);
  assert.equal((await c.del(`/api/files/${fileA.id}`)).status, 404);
  assert.equal((await c.post(`/api/files/${fileA.id}/restore`)).status, 404);
  assert.equal((await c.del(`/api/trash/${fileA.id}`)).status, 404);

  const still = await a.client.get(`/api/files/${fileA.id}`);
  assert.equal(still.data.data.name, "secret.txt");
  assert.equal(still.data.data.deletedAt, null);
});

test("IDOR: user B cannot see or use user A's folders", async () => {
  const c = b.client;
  assert.equal((await c.get(`/api/folders?parent_id=${folderA.id}`)).status, 404);
  assert.equal((await c.get(`/api/files?folder_id=${folderA.id}`)).status, 404);
  assert.equal((await c.post("/api/folders", { json: { name: "x", parent_id: folderA.id } })).status, 404);
  assert.equal((await c.patch(`/api/folders/${folderA.id}`, { json: { name: "pwned" } })).status, 404);
  assert.equal((await c.del(`/api/folders/${folderA.id}`)).status, 404);
  assert.equal((await c.upload("drop.txt", Buffer.from("x"), { folderId: folderA.id })).status, 404);
});

test("IDOR (review finding): user B cannot read or cancel user A's upload job", async () => {
  assert.equal((await b.client.get(`/api/uploads/${jobA.id}`)).status, 404);
  assert.equal((await b.client.del(`/api/uploads/${jobA.id}`)).status, 404);
  assert.equal((await a.client.get(`/api/uploads/${jobA.id}`)).status, 200);
});

test("Search and listings never leak other users' files", async () => {
  const search = await b.client.get("/api/search?q=secret");
  assert.equal(search.data.data.length, 0);
  const recent = await b.client.get("/api/files?filter=recent");
  assert.equal(recent.data.data.length, 0);
});

test("Peer-level isolation: an object outside the user's storage peer is refused", async () => {
  // Simulate a corrupted/tampered mapping pointing A's file at B's storage peer.
  const stored = await h.telegramObjects.getByFileId(a.user.id, fileA.id);
  const peerB = (await h.users.getStoragePeer(b.user.id)).channelId;
  await h.telegramObjects.saveObject({ ...stored, peerId: peerB });
  try {
    assert.equal((await a.client.get(`/api/files/${fileA.id}/content`)).status, 403);
  } finally {
    await h.telegramObjects.saveObject(stored);
  }
  assert.equal((await a.client.get(`/api/files/${fileA.id}/content`)).status, 200);
});

test("DoS regression (review finding): moving a folder into itself/descendant is rejected and the server stays up", async () => {
  const top = (await a.client.post("/api/folders", { json: { name: "Top" } })).data.data;
  const mid = (await a.client.post("/api/folders", { json: { name: "Mid", parent_id: top.id } })).data.data;
  const leaf = (await a.client.post("/api/folders", { json: { name: "Leaf", parent_id: mid.id } })).data.data;

  assert.equal((await a.client.patch(`/api/folders/${top.id}`, { json: { parent_id: top.id } })).status, 400);
  assert.equal((await a.client.patch(`/api/folders/${top.id}`, { json: { parent_id: leaf.id } })).status, 400);

  const crumbs = await a.client.get(`/api/folders?parent_id=${leaf.id}`);
  assert.equal(crumbs.status, 200);
  assert.deepEqual(crumbs.data.meta.breadcrumbs.map(c => c.name), ["My Drive", "Top", "Mid", "Leaf"]);
  assert.equal((await h.client().get("/api/health")).status, 200);
});

test("Stored XSS (review finding): HTML is never served inline as text/html", async () => {
  const res = await a.client.get(`/api/files/${htmlFile.id}/content`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  assert.match(res.headers.get("content-disposition"), /^attachment;/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("content-security-policy"), /sandbox/);

  const text = await a.client.get(`/api/files/${htmlFile.id}/content?as=text`);
  assert.equal(text.headers.get("content-type"), "text/plain; charset=utf-8");

  const download = await a.client.get(`/api/files/${fileA.id}/content?disposition=attachment`);
  assert.match(download.headers.get("content-disposition"), /^attachment;.*filename\*=UTF-8''secret\.txt/);
});

test("CSRF: cross-origin state-changing requests are rejected", async () => {
  const res = await a.client.post("/api/folders", { json: { name: "csrf" }, headers: { Origin: "https://evil.example" } });
  assert.equal(res.status, 403);
  const sameOrigin = await a.client.post("/api/folders", { json: { name: "ok" }, headers: { Origin: h.baseUrl } });
  assert.equal(sameOrigin.status, 201);
});

test("Auth: no bearer tokens, no session in bodies, 401 without cookie", async () => {
  const anon = h.client();
  assert.equal((await anon.get("/api/me")).status, 401);
  assert.equal((await anon.get("/api/files")).status, 401);
  const token = a.client.cookie.split("=")[1];
  assert.equal((await anon.get("/api/me", { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  assert.notEqual((await anon.post("/api/auth/register", { json: { email: "a@b.c", password: "x" } })).status, 200, "password auth no longer exists");
});

test("QR login attempts are bound to the initiating browser", async () => {
  const victim = h.client();
  await victim.post("/api/auth/qr");
  const attacker = h.client();
  assert.equal((await attacker.get("/api/auth/qr")).status, 404, "no cookie → nothing to poll");
  const forged = h.client(victim.cookie.replace(/\.[^.;]+$/, ".forgedsecret"));
  assert.equal((await forged.get("/api/auth/qr")).status, 404, "wrong secret → nothing to poll");
});

test("Validation: malformed ids, bodies and queries return 400 envelopes", async () => {
  const c = a.client;
  assert.equal((await c.get("/api/files/not-an-id")).status, 400);
  assert.equal((await c.get("/api/files?limit=99999")).status, 400);
  assert.equal((await c.get("/api/files?cursor=%%%")).status, 400);
  assert.equal((await c.post("/api/folders", { json: { name: "../etc" } })).status, 400);
  assert.equal((await c.post("/api/folders", { json: { name: ".." } })).status, 400);
  assert.equal((await c.patch(`/api/folders/${folderA.id}`, { json: { name: "a/b" } })).status, 400);
  assert.equal((await c.patch(`/api/files/${fileA.id}`, { json: {} })).status, 400);
  const bad = await c.post("/api/folders", { json: "{not json" });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error.code, "VALIDATION_ERROR");
  assert.equal((await c.get("/api/nope")).status, 404);
});

test("Upload limits: oversize uploads are rejected and nothing is left behind", async () => {
  const big = Buffer.alloc(6 * 1024 * 1024, 1);
  const res = await a.client.upload("big.bin", big);
  assert.equal(res.status, 413);
  const names = (await a.client.get("/api/files")).data.data.map(f => f.name);
  assert.equal(names.includes("big.bin"), false);
});

test("Internal errors never leak messages", async () => {
  const original = h.files.getStorageAnalytics;
  h.files.getStorageAnalytics = async () => {
    throw new Error("SQLITE_CORRUPT: secret path C:/data/teledrive.sqlite");
  };
  const errorLog = console.error;
  console.error = () => {};
  try {
    const res = await a.client.get("/api/storage");
    assert.equal(res.status, 500);
    assert.equal(res.data.error.message, "Internal server error");
  } finally {
    h.files.getStorageAnalytics = original;
    console.error = errorLog;
  }
});
