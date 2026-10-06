/**
 * Reliability: reference refresh (ADR-005), per-user FLOOD_WAIT, session revocation,
 * durable worker retries and restart recovery.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  Database,
  UserRepository,
  FileRepository,
  JobRepository,
  TelegramObjectRepository
} from "../../packages/database/dist/index.js";
import { MockStorageAdapter } from "../../packages/storage/dist/index.js";
import { AppError, ErrorCode, FloodWaitError } from "../../packages/shared/dist/index.js";
import { TelegramConnectorService, SessionCrypto } from "../../workers/telegram-connector/dist/index.js";
import { StorageWorker } from "../../workers/storage-worker/dist/index.js";

async function setup(adapterFor) {
  const db = new Database(":memory:");
  const users = new UserRepository(db);
  const files = new FileRepository(db);
  const jobs = new JobRepository(db);
  const telegramObjects = new TelegramObjectRepository(db);
  const sessionCrypto = new SessionCrypto(crypto.randomBytes(32).toString("hex"));
  const adapters = new Map();
  const connector = new TelegramConnectorService({
    mode: "telegram",
    users,
    telegramObjects,
    crypto: sessionCrypto,
    adapterFactory: async userId => {
      if (!adapters.has(userId)) adapters.set(userId, adapterFor ? adapterFor(userId) : new MockStorageAdapter(`peer_${userId.slice(4, 10)}`));
      return adapters.get(userId);
    }
  });
  const makeUser = async tg => {
    const user = await users.upsertFromTelegram({ telegramUserId: tg, displayName: tg, username: null, sessionEnc: sessionCrypto.encrypt("s") });
    return user;
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "td-rel-"));
  const spool = (name, content) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, content);
    return p;
  };
  return { db, users, files, jobs, telegramObjects, connector, adapters, makeUser, tmp, spool };
}

async function collect(iterable) {
  const chunks = [];
  for await (const c of iterable) chunks.push(c);
  return Buffer.concat(chunks);
}

test("Reference refresh: expired file_reference is refreshed, persisted, and the download completes", async () => {
  const s = await setup();
  const user = await s.makeUser("1");
  const file = await s.files.createFile(user.id, { name: "a.bin", mimeType: "x/y", sizeBytes: 40000, status: "ready" });
  const content = crypto.randomBytes(40000);
  const stored = await s.connector.executeUpload(user.id, { fileId: file.id, name: "a.bin", mimeType: "x/y", sizeBytes: content.length, filePath: s.spool("a", content) });
  await s.telegramObjects.saveObject({ ...stored, createdAt: new Date().toISOString() });

  const adapter = s.adapters.get(user.id);
  adapter.simulateExpiredReference = true;
  const body = await collect(s.connector.downloadStream(user.id, stored, { offsetBytes: 1000, lengthBytes: 20000 }));
  assert.ok(body.equals(content.subarray(1000, 21000)));
  assert.equal(adapter.refreshCount, 1);

  const persisted = await s.telegramObjects.getByFileId(user.id, file.id);
  assert.equal(persisted.fileReference, "mock_ref_refreshed_1", "new reference saved to the database");
  await s.connector.shutdown();
});

test("FLOOD_WAIT is tracked per Telegram account: user A waits, user B is unaffected", async () => {
  const s = await setup();
  const a = await s.makeUser("A");
  const b = await s.makeUser("B");
  const input = id => ({ fileId: `fil_${crypto.randomUUID()}`, name: "x", mimeType: "x/y", sizeBytes: 1, filePath: s.spool(id, "x") });

  await s.connector.executeUpload(a.id, input("warm-a"));
  s.adapters.get(a.id).simulateFloodWaitSeconds = 30;
  await assert.rejects(s.connector.executeUpload(a.id, input("a1")), FloodWaitError);
  await assert.rejects(s.connector.executeUpload(a.id, input("a2")), err => err instanceof FloodWaitError && err.seconds > 25, "window remembered");
  await s.connector.executeUpload(b.id, input("b1")); // B is fine
  await s.connector.shutdown();
});

test("Revoked Telegram session: user is marked revoked and app sessions end", async () => {
  const revoking = new MockStorageAdapter("peer_r");
  revoking.upload = async () => {
    throw new AppError(ErrorCode.TELEGRAM_AUTH_REQUIRED, "Telegram session is no longer valid", 401);
  };
  const s = await setup(() => revoking);
  const user = await s.makeUser("R");
  const { token } = await s.users.createSession(user.id);
  await assert.rejects(
    s.connector.executeUpload(user.id, { fileId: "fil_x", name: "x", mimeType: "x/y", sizeBytes: 1, filePath: s.spool("r", "x") }),
    err => err.code === ErrorCode.TELEGRAM_AUTH_REQUIRED
  );
  assert.equal(await s.users.validateSession(token), null);
  assert.equal((await s.users.getUserById(user.id)).telegramStatus, "revoked");
  await s.connector.shutdown();
});

function workerFor(s, extra = {}) {
  return new StorageWorker({
    jobs: s.jobs, files: s.files, telegramObjects: s.telegramObjects, connector: s.connector,
    tempDir: s.tmp, pollIntervalMs: 20, baseBackoffMs: 10, ...extra
  });
}

async function waitFor(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 15));
  }
  throw new Error("timed out");
}

test("Worker: transient failures are retried with backoff, then succeed", async () => {
  const s = await setup();
  const user = await s.makeUser("W");
  (await s.connector.executeExists(user.id, { fileId: "fil_none", peerId: "", messageId: 0, documentId: "", accessHash: "", fileReference: "", dcId: 0 }));
  s.adapters.get(user.id).uploadFailuresRemaining = 2;

  const file = await s.files.createFile(user.id, { name: "w.txt", mimeType: "text/plain", sizeBytes: 5 });
  const tempPath = s.spool("upl_w", "hello");
  const job = await s.jobs.createJob(user.id, file.id, 5, tempPath);
  const worker = workerFor(s);
  await worker.start();

  const done = await waitFor(async () => {
    const j = await s.jobs.getJobById(user.id, job.id);
    return j.status === "completed" ? j : null;
  });
  assert.equal(done.attempts, 3);
  assert.equal((await s.files.getFileById(user.id, file.id)).status, "ready");
  assert.equal(fs.existsSync(tempPath), false, "spooled temp file removed after success");
  await worker.stop();
  await s.connector.shutdown();
});

test("Worker: FLOOD_WAIT delays the retry for at least the requested time", async () => {
  const s = await setup();
  const user = await s.makeUser("F");
  const file = await s.files.createFile(user.id, { name: "f.txt", mimeType: "text/plain", sizeBytes: 1 });
  const job = await s.jobs.createJob(user.id, file.id, 1, s.spool("upl_f", "x"));
  await s.connector.executeExists(user.id, { fileId: "fil_none", peerId: "", messageId: 0, documentId: "", accessHash: "", fileReference: "", dcId: 0 });
  s.adapters.get(user.id).simulateFloodWaitSeconds = 120;

  const worker = workerFor(s);
  await worker.start();
  const retry = await waitFor(() => s.db.get("SELECT * FROM jobs WHERE id = ? AND status = 'queued' AND attempts = 1", job.id));
  const delayMs = new Date(retry.run_after).getTime() - Date.now();
  assert.ok(delayMs > 110_000, `retry scheduled ~120s later (got ${delayMs}ms)`);
  assert.equal(retry.error_code, ErrorCode.STORAGE_RATE_LIMITED);
  await worker.stop();
  await s.connector.shutdown();
});

test("Worker: jobs interrupted by a crash resume after restart; missing payloads fail cleanly", async () => {
  const s = await setup();
  const user = await s.makeUser("C");
  const okFile = await s.files.createFile(user.id, { name: "ok.txt", mimeType: "text/plain", sizeBytes: 2 });
  const okJob = await s.jobs.createJob(user.id, okFile.id, 2, s.spool("upl_ok", "ok"));
  const lostFile = await s.files.createFile(user.id, { name: "lost.txt", mimeType: "text/plain", sizeBytes: 2 });
  const lostJob = await s.jobs.createJob(user.id, lostFile.id, 2, path.join(s.tmp, "does-not-exist"));
  // Simulate a crash mid-transfer.
  s.db.run("UPDATE jobs SET status = 'processing'");

  const worker = workerFor(s);
  await worker.start();
  await waitFor(async () => (await s.jobs.getJobById(user.id, okJob.id)).status === "completed");
  const lost = await waitFor(async () => {
    const j = await s.jobs.getJobById(user.id, lostJob.id);
    return j.status === "failed" ? j : null;
  });
  assert.equal(lost.errorCode, "UPLOAD_DATA_MISSING");
  assert.equal((await s.files.getFileById(user.id, lostFile.id)).status, "failed");
  await worker.stop();
  await s.connector.shutdown();
});

test("Undecryptable session (encryption key changed/lost): user is sent to re-login instead of getting 500s", async () => {
  const db = new Database(":memory:");
  const users = new UserRepository(db);
  const oldKey = new SessionCrypto(crypto.randomBytes(32).toString("hex"));
  const newKey = new SessionCrypto(crypto.randomBytes(32).toString("hex"));
  const user = await users.upsertFromTelegram({ telegramUserId: "K", displayName: "K", username: null, sessionEnc: oldKey.encrypt("session") });
  const { token } = await users.createSession(user.id);

  // Real (non-test) connector path: it must fail while decrypting, before any Telegram connection is attempted.
  const connector = new TelegramConnectorService({
    mode: "telegram",
    users,
    telegramObjects: new TelegramObjectRepository(db),
    crypto: newKey,
    credentials: { apiId: 1, apiHash: "0".repeat(32) }
  });
  const object = { fileId: "f", peerId: "p", messageId: 1, documentId: "d", accessHash: "h", fileReference: "r", dcId: 2 };
  const errorLog = console.error;
  console.error = () => {};
  try {
    await assert.rejects(connector.executeExists(user.id, object), err => err.code === ErrorCode.TELEGRAM_AUTH_REQUIRED && err.statusCode === 401);
  } finally {
    console.error = errorLog;
  }
  assert.equal((await users.getUserById(user.id)).telegramStatus, "revoked");
  assert.equal(await users.validateSession(token), null, "app sessions ended so the UI returns to the QR login");
  await connector.logoutTelegram(user.id); // must not throw for an already-unusable session
  await connector.shutdown();
});
