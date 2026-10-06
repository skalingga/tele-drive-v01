import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import {
  Database,
  UserRepository,
  FolderRepository,
  FileRepository,
  JobRepository,
  TelegramObjectRepository
} from "@teledrive/database";
import { TelegramConnectorService, QrLoginService, SessionCrypto } from "@teledrive/telegram-connector";
import { StorageWorker } from "@teledrive/storage-worker";
import { loadEnvFile, readConfig } from "./config.ts";
import { createApp, attachErrorHandler } from "./app.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  loadEnvFile();
  const config = readConfig();

  const db = new Database(config.databasePath);
  const users = new UserRepository(db);
  const folders = new FolderRepository(db);
  const files = new FileRepository(db);
  const jobs = new JobRepository(db);
  const telegramObjects = new TelegramObjectRepository(db);
  const crypto = new SessionCrypto(config.sessionEncryptionKey);

  // This process is the single owner of every MTProto session (ADR-007). Run exactly one instance.
  const connector = new TelegramConnectorService({
    mode: config.storageMode,
    users,
    telegramObjects,
    crypto,
    credentials: config.telegram,
    localStorageDir: config.localStorageDir,
    adapterOptions: { connections: config.downloadConnections }
  });
  const qrLogin = new QrLoginService(config.telegram, connector, users, crypto);
  const worker = new StorageWorker({ jobs, files, telegramObjects, connector, tempDir: config.uploadTempDir });

  const production = config.nodeEnv === "production";
  const app = createApp({
    users, folders, files, jobs, telegramObjects, connector, worker, qrLogin,
    uploadTempDir: config.uploadTempDir,
    maxUploadBytes: config.maxUploadBytes,
    secureCookies: config.secureCookies,
    production,
    trustProxy: config.trustProxy
  });

  const server = http.createServer(app);

  if (production) {
    const distPath = path.join(webRoot, "dist");
    if (!fs.existsSync(path.join(distPath, "index.html"))) {
      throw new Error(`Production build not found at ${distPath}. Run "npm run build" first.`);
    }
    app.use(express.static(distPath, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(distPath, "index.html")));
  } else {
    // Development always uses Vite (never a stale dist/ bundle).
    const { createServer } = await import("vite");
    // HMR rides on this server's own HTTP port. Vite's default separate HMR port (24678) is
    // shared across every Vite dev server on the machine; a clash makes the browser reload in a loop.
    const vite = await createServer({
      server: { middlewareMode: true, hmr: { server } },
      appType: "spa",
      root: webRoot
    });
    app.use(vite.middlewares);
  }
  attachErrorHandler(app);

  await worker.start();
  const sessionSweep = setInterval(() => void users.purgeExpiredSessions(), 60 * 60 * 1000);
  sessionSweep.unref();

  server.listen(config.port, () => {
    console.log(`[TeleDrive] ${config.nodeEnv} server on http://localhost:${config.port} (storage: ${config.storageMode})`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[TeleDrive] ${signal} received, shutting down…`);
    server.close();
    await worker.stop();
    await qrLogin.shutdown();
    await connector.shutdown();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch(err => {
  console.error(`[TeleDrive] Failed to start: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
