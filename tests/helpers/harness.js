/**
 * Self-contained test harness: real API (createApp) on an ephemeral port, in-memory
 * SQLite, MockStorageAdapter per user, and a fake QR login provider. No Telegram, no
 * external server, no shared state between test files.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  Database,
  UserRepository,
  FolderRepository,
  FileRepository,
  JobRepository,
  TelegramObjectRepository
} from "../../packages/database/dist/index.js";
import { MockStorageAdapter } from "../../packages/storage/dist/index.js";
import { AppError } from "../../packages/shared/dist/index.js";
import { TelegramConnectorService, SessionCrypto } from "../../workers/telegram-connector/dist/index.js";
import { StorageWorker } from "../../workers/storage-worker/dist/index.js";
import { createApp, attachErrorHandler } from "../../apps/web/server/app.ts";

export const TEST_KEY = crypto.randomBytes(32).toString("hex");

/** Stand-in for QrLoginService: the test decides which Telegram account "scanned" the code. */
export class FakeQrLogin {
  constructor(users, crypto, harness) {
    this.users = users;
    this.crypto = crypto;
    this.harness = harness;
    this.attempts = new Map();
  }
  get activeAttempts() {
    return this.attempts.size;
  }
  start() {
    const attemptId = `qr_${crypto.randomBytes(18).toString("base64url")}`;
    const browserSecret = crypto.randomBytes(32).toString("base64url");
    this.attempts.set(attemptId, { secret: browserSecret, identity: null, password: null, needsPassword: false });
    this.lastAttemptId = attemptId;
    return { attemptId, browserSecret };
  }
  entry(attemptId, secret) {
    const e = this.attempts.get(attemptId);
    if (!e || e.secret !== secret) throw new AppError("NOT_FOUND", "Login attempt not found or expired", 404);
    return e;
  }
  /** Simulate the phone scanning the QR of the most recent attempt. */
  scan(identity, { needsPassword = false } = {}) {
    const e = this.attempts.get(this.lastAttemptId);
    e.identity = identity;
    e.needsPassword = needsPassword;
  }
  async status(attemptId, secret) {
    const e = this.entry(attemptId, secret);
    if (!e.identity) return { state: { status: "waiting", qrUrl: "tg://login?token=fake", expiresAt: new Date(Date.now() + 30000).toISOString() }, user: null };
    if (e.needsPassword && e.password !== "correct horse") {
      return { state: { status: "password_required", hint: "horse", passwordError: e.password ? "Password 2FA salah. Coba lagi." : null }, user: null };
    }
    const user = await this.users.upsertFromTelegram({ ...e.identity, sessionEnc: this.crypto.encrypt("fake-session") });
    await this.harness.provisionPeer(user.id);
    this.attempts.delete(attemptId);
    return { state: { status: "success" }, user };
  }
  submitPassword(attemptId, secret, password) {
    this.entry(attemptId, secret).password = password;
  }
  async cancel(attemptId, secret) {
    this.entry(attemptId, secret);
    this.attempts.delete(attemptId);
  }
}

export async function startHarness(options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "teledrive-test-"));
  const db = new Database(":memory:");
  const users = new UserRepository(db);
  const folders = new FolderRepository(db);
  const files = new FileRepository(db);
  const jobs = new JobRepository(db);
  const telegramObjects = new TelegramObjectRepository(db);
  const sessionCrypto = new SessionCrypto(TEST_KEY);

  const adapters = new Map();
  const harness = {
    db, users, folders, files, jobs, telegramObjects, tempDir, adapters,
    adapterFor(userId) {
      if (!adapters.has(userId)) adapters.set(userId, new MockStorageAdapter(`mock_${userId.slice(4, 12)}`));
      return adapters.get(userId);
    },
    async provisionPeer(userId) {
      await users.setStoragePeer(userId, { channelId: harness.adapterFor(userId).peerId, accessHash: "0" });
    }
  };

  const connector = new TelegramConnectorService({
    mode: "telegram",
    users,
    telegramObjects,
    crypto: sessionCrypto,
    adapterFactory: async userId => harness.adapterFor(userId)
  });
  const worker = new StorageWorker({
    jobs, files, telegramObjects, connector,
    tempDir: path.join(tempDir, "uploads"),
    pollIntervalMs: 50,
    baseBackoffMs: 20,
    ...options.worker
  });
  const qrLogin = new FakeQrLogin(users, sessionCrypto, harness);

  const app = createApp({
    users, folders, files, jobs, telegramObjects, connector, worker, qrLogin,
    uploadTempDir: path.join(tempDir, "uploads"),
    maxUploadBytes: options.maxUploadBytes ?? 5 * 1024 * 1024,
    secureCookies: false,
    production: false,
    apiRateLimitPerMinute: 10_000
  });
  attachErrorHandler(app);
  await worker.start();

  const server = await new Promise(resolve => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  Object.assign(harness, {
    connector, worker, qrLogin, server, baseUrl,
    async close() {
      await worker.stop();
      await connector.shutdown();
      await new Promise(resolve => server.close(resolve));
      server.closeAllConnections?.();
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
    /** Creates a user + session directly (bypassing QR) and returns a client bound to its cookie. */
    async login(telegramUserId = String(crypto.randomInt(1e9))) {
      const user = await users.upsertFromTelegram({
        telegramUserId,
        displayName: `User ${telegramUserId}`,
        username: null,
        sessionEnc: sessionCrypto.encrypt("fake-session")
      });
      await harness.provisionPeer(user.id);
      const { token } = await users.createSession(user.id);
      return { user, client: makeClient(baseUrl, `td_session=${token}`) };
    },
    client(cookie = "") {
      return makeClient(baseUrl, cookie);
    }
  });
  return harness;
}

function makeClient(baseUrl, cookie) {
  const client = {
    cookie,
    async request(method, urlPath, { json, form, headers = {} } = {}) {
      const h = { ...headers };
      if (client.cookie) h.Cookie = client.cookie;
      let body;
      if (json !== undefined) {
        h["Content-Type"] = "application/json";
        body = typeof json === "string" ? json : JSON.stringify(json);
      } else if (form) {
        body = form;
      }
      const res = await fetch(`${baseUrl}${urlPath}`, { method, headers: h, body, redirect: "manual" });
      // Keep cookies issued by the server (QR flow / logout).
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(";");
        const [name] = pair.split("=");
        const jar = new Map(client.cookie ? client.cookie.split("; ").map(c => [c.split("=")[0], c]) : []);
        if (/expires=Thu, 01 Jan 1970/i.test(raw) || pair.endsWith("=")) jar.delete(name);
        else jar.set(name, pair);
        client.cookie = [...jar.values()].join("; ");
      }
      const type = res.headers.get("content-type") ?? "";
      const buffer = Buffer.from(await res.arrayBuffer());
      const data = type.includes("application/json") ? JSON.parse(buffer.toString("utf8")) : buffer;
      return { status: res.status, headers: res.headers, data, setCookies: res.headers.getSetCookie?.() ?? [] };
    },
    get: (p, o) => client.request("GET", p, o),
    post: (p, o) => client.request("POST", p, o),
    patch: (p, o) => client.request("PATCH", p, o),
    del: (p, o) => client.request("DELETE", p, o),
    async upload(fileName, content, { mimeType = "application/octet-stream", folderId } = {}) {
      const form = new FormData();
      if (folderId) form.append("folder_id", folderId);
      form.append("file", new Blob([content], { type: mimeType }), fileName);
      return client.post("/api/files/upload", { form });
    },
    /** Uploads and waits for the worker to finish the transfer. */
    async uploadAndWait(fileName, content, options) {
      const res = await client.upload(fileName, content, options);
      if (res.status !== 202) throw new Error(`upload failed: ${res.status} ${JSON.stringify(res.data)}`);
      const job = await waitForJob(client, res.data.data.job.id);
      return { file: res.data.data.file, job };
    }
  };
  return client;
}

export async function waitForJob(client, jobId, terminal = ["completed", "failed", "cancelled"], timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await client.get(`/api/uploads/${jobId}`);
    if (res.status === 200 && terminal.includes(res.data.data.status)) return res.data.data;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`job ${jobId} did not finish in time`);
}
