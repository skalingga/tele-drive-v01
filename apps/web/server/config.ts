import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { REPO_ROOT, resolveDataPath } from "@teledrive/database";

/** Loads `<repo>/.env` into process.env (existing variables win). */
export function loadEnvFile(): void {
  const envPath = path.join(REPO_ROOT, ".env");
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
}

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  STORAGE_MODE: z.enum(["telegram", "local"]).default("telegram"),
  TELEGRAM_API_ID: z.coerce.number().int().positive({ message: "TELEGRAM_API_ID is required (get it from https://my.telegram.org)" }),
  TELEGRAM_API_HASH: z.string().regex(/^[0-9a-f]{32}$/i, "TELEGRAM_API_HASH must be the 32-char hash from https://my.telegram.org"),
  TELEGRAM_SESSION_ENCRYPTION_KEY: z.string().min(1, "TELEGRAM_SESSION_ENCRYPTION_KEY is required"),
  DATABASE_PATH: z.string().optional(),
  UPLOAD_TEMP_DIR: z.string().optional(),
  LOCAL_STORAGE_DIR: z.string().optional(),
  /** Telegram limit for non-Premium accounts is 2 GiB per file. */
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(4000).default(2000),
  /** Parallel Telegram connections per user used to stream downloads. */
  DOWNLOAD_CONNECTIONS: z.coerce.number().int().min(1).max(8).default(4),
  COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  TRUST_PROXY: z.string().optional()
});

export interface AppConfig {
  nodeEnv: "development" | "production" | "test";
  port: number;
  storageMode: "telegram" | "local";
  telegram: { apiId: number; apiHash: string };
  sessionEncryptionKey: string;
  databasePath: string;
  uploadTempDir: string;
  localStorageDir: string;
  maxUploadBytes: number;
  downloadConnections: number;
  secureCookies: boolean;
  trustProxy: string | undefined;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(i => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration (check .env, see .env.example):\n${problems}`);
  }
  const c = parsed.data;
  return {
    nodeEnv: c.NODE_ENV,
    port: c.PORT,
    storageMode: c.STORAGE_MODE,
    telegram: { apiId: c.TELEGRAM_API_ID, apiHash: c.TELEGRAM_API_HASH },
    sessionEncryptionKey: c.TELEGRAM_SESSION_ENCRYPTION_KEY,
    databasePath: resolveDataPath(c.DATABASE_PATH, "data/teledrive.sqlite"),
    uploadTempDir: resolveDataPath(c.UPLOAD_TEMP_DIR, "data/tmp/uploads"),
    localStorageDir: resolveDataPath(c.LOCAL_STORAGE_DIR, "data/storage"),
    maxUploadBytes: c.MAX_UPLOAD_MB * 1024 * 1024,
    downloadConnections: c.DOWNLOAD_CONNECTIONS,
    secureCookies: c.COOKIE_SECURE ? c.COOKIE_SECURE === "true" : c.NODE_ENV === "production",
    trustProxy: c.TRUST_PROXY
  };
}
