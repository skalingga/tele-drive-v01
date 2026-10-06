import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import { ErrorCode } from "@teledrive/shared";
import type { UserRepository, FolderRepository, FileRepository, JobRepository, TelegramObjectRepository } from "@teledrive/database";
import type { TelegramConnectorService, QrLoginProvider } from "@teledrive/telegram-connector";
import type { StorageWorker } from "@teledrive/storage-worker";
import { errorHandler, sendError, sendSuccess } from "./http.ts";
import { requireAuth, requireUser, securityHeaders, sameOriginMutations, rateLimit, userKey } from "./middleware.ts";
import { authRoutes } from "./routes/auth.routes.ts";
import { driveRoutes } from "./routes/drive.routes.ts";

export interface AppDeps {
  users: UserRepository;
  folders: FolderRepository;
  files: FileRepository;
  jobs: JobRepository;
  telegramObjects: TelegramObjectRepository;
  connector: TelegramConnectorService;
  worker: StorageWorker;
  qrLogin: QrLoginProvider;
  uploadTempDir: string;
  maxUploadBytes: number;
  secureCookies: boolean;
  production: boolean;
  trustProxy?: string;
  apiRateLimitPerMinute?: number;
}

/** Builds the HTTP API. Static/client serving is attached separately (see main.ts). */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  if (deps.trustProxy) app.set("trust proxy", deps.trustProxy);

  app.use(securityHeaders({ production: deps.production }));
  app.use(express.json({ limit: "64kb" }));
  app.use(cookieParser());
  app.use("/api", sameOriginMutations());

  app.get("/api/health", (_req, res) => {
    sendSuccess(res, { status: "ok", connector: deps.connector.health, timestamp: new Date().toISOString() });
  });

  app.use("/api/auth", authRoutes({ users: deps.users, qrLogin: deps.qrLogin, connector: deps.connector, secureCookies: deps.secureCookies }));

  const authed = express.Router();
  authed.use(requireAuth(deps.users));
  authed.use(rateLimit({ windowMs: 60 * 1000, max: deps.apiRateLimitPerMinute ?? 600, key: userKey }));
  authed.get("/me", (req, res) => sendSuccess(res, requireUser(req)));
  authed.use(driveRoutes({
    folders: deps.folders,
    files: deps.files,
    jobs: deps.jobs,
    telegramObjects: deps.telegramObjects,
    connector: deps.connector,
    worker: deps.worker,
    uploadTempDir: deps.uploadTempDir,
    maxUploadBytes: deps.maxUploadBytes
  }));
  app.use("/api", authed);

  // Unknown API routes are JSON 404s — never the SPA's index.html.
  app.use("/api", (_req, res) => sendError(res, 404, ErrorCode.NOT_FOUND, "Endpoint not found"));
  return app;
}

/** Must be registered after the client middleware so it also catches errors from there. */
export function attachErrorHandler(app: Express): void {
  app.use(errorHandler);
}
