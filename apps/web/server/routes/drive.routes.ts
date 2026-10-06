import fs from "node:fs";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Router } from "express";
import multer from "multer";
import {
  AppError,
  ErrorCode,
  FileIdSchema,
  FolderIdSchema,
  JobIdSchema,
  FileListQuerySchema,
  FolderListQuerySchema,
  SearchQuerySchema,
  CreateFolderSchema,
  UpdateFolderSchema,
  UpdateFileSchema,
  UploadBodySchema,
  ContentQuerySchema,
  sanitizeFileName,
  parseRangeHeader,
  resolveServedContentType,
  contentDispositionHeader
} from "@teledrive/shared";
import type { FolderRepository, FileRepository, JobRepository, TelegramObjectRepository } from "@teledrive/database";
import type { TelegramConnectorService } from "@teledrive/telegram-connector";
import type { StorageWorker } from "@teledrive/storage-worker";
import { asyncHandler, sendSuccess } from "../http.ts";
import { requireUser } from "../middleware.ts";

export interface DriveRouteDeps {
  folders: FolderRepository;
  files: FileRepository;
  jobs: JobRepository;
  telegramObjects: TelegramObjectRepository;
  connector: TelegramConnectorService;
  worker: StorageWorker;
  uploadTempDir: string;
  maxUploadBytes: number;
  maxOpenJobsPerUser?: number;
}

const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

/** Stream errors Node raises when the other end of the socket has gone away. */
const CLIENT_ABORT_CODES = new Set([
  "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_STREAM_UNABLE_TO_PIPE",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE"
]);

/**
 * Decided by the error code alone. Socket state cannot tell the cases apart: `stream.pipeline` destroys
 * the response before it rejects, so `res.destroyed` is true for storage failures too, and `req.destroyed`
 * is already true for a body-less GET while the response is still streaming.
 */
function isClientAbort(err: unknown): boolean {
  return CLIENT_ABORT_CODES.has((err as NodeJS.ErrnoException)?.code ?? "");
}
const MIME_PATTERN = /^[a-z0-9][\w.+-]*\/[a-z0-9][\w.+-]*$/i;

export function driveRoutes(deps: DriveRouteDeps): Router {
  const router = Router();
  const maxOpenJobs = deps.maxOpenJobsPerUser ?? 50;
  fs.mkdirSync(deps.uploadTempDir, { recursive: true });

  // Uploads are spooled to disk (never held in memory) and handed to the durable worker.
  const upload = multer({
    storage: multer.diskStorage({
      destination: deps.uploadTempDir,
      filename: (_req, _file, cb) => cb(null, `upl_${crypto.randomUUID()}`)
    }),
    limits: { fileSize: deps.maxUploadBytes, files: 1, fields: 5, fieldSize: 1024, parts: 10 }
  });

  // ─── Folders ───────────────────────────────────────────────────────────────

  router.get("/folders", asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const query = FolderListQuerySchema.parse(req.query);
    const trash = query.filter === "trash";
    const result = await deps.folders.listFolders(user.id, { parentId: query.parent_id ?? null, trash, cursor: query.cursor, limit: query.limit });
    const breadcrumbs = trash ? [] : await deps.folders.getBreadcrumbs(user.id, query.parent_id ?? null);
    sendSuccess(res, result.items, { next_cursor: result.nextCursor, total: result.total, breadcrumbs });
  }));

  router.post("/folders", asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const body = CreateFolderSchema.parse(req.body);
    sendSuccess(res, await deps.folders.createFolder(user.id, body.name, body.parent_id ?? null), {}, 201);
  }));

  router.patch("/folders/:id", asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const id = FolderIdSchema.parse(req.params.id);
    const body = UpdateFolderSchema.parse(req.body);
    sendSuccess(res, await deps.folders.updateFolder(user.id, id, { name: body.name, parentId: body.parent_id }));
  }));

  router.delete("/folders/:id", asyncHandler(async (req, res) => {
    const user = requireUser(req);
    await deps.folders.softDeleteFolder(user.id, FolderIdSchema.parse(req.params.id));
    sendSuccess(res, { trashed: true });
  }));

  router.post("/folders/:id/restore", asyncHandler(async (req, res) => {
    const user = requireUser(req);
    sendSuccess(res, await deps.folders.restoreFolder(user.id, FolderIdSchema.parse(req.params.id)));
  }));

  // ─── Files ─────────────────────────────────────────────────────────────────

  router.get("/files", asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const query = FileListQuerySchema.parse(req.query);
    const result = await deps.files.listFiles(user.id, {
      folderId: query.folder_id ?? null,
      cursor: query.cursor,
      limit: query.limit,
      filter: query.filter,
      sort: query.sort,
      type: query.type
    });
    sendSuccess(res, result.items, { next_cursor: result.nextCursor, total: result.total });
  }));

  const checkUploadQuota = asyncHandler(async (req, _res, next) => {
    const user = requireUser(req);
    if ((await deps.jobs.countOpenJobs(user.id)) >= maxOpenJobs) {
      throw new AppError(ErrorCode.RATE_LIMITED, "Too many uploads in progress. Wait for some to finish.", 429);
    }
    next();
  });

  router.post("/files/upload", checkUploadQuota, upload.single("file"), asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const spooled = req.file;
    if (!spooled) throw new AppError(ErrorCode.VALIDATION_ERROR, "No file uploaded", 400);

    try {
      const body = UploadBodySchema.parse(req.body);
      // Multer decodes multipart filenames as latin1; browsers send UTF-8.
      const name = sanitizeFileName(Buffer.from(spooled.originalname, "latin1").toString("utf8"));
      if (!name) throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid file name", 400);
      const mimeType = MIME_PATTERN.test(spooled.mimetype) ? spooled.mimetype.toLowerCase() : "application/octet-stream";

      const file = await deps.files.createFile(user.id, {
        name,
        mimeType,
        sizeBytes: spooled.size,
        folderId: body.folder_id ?? null,
        status: "pending"
      });
      const job = await deps.jobs.createJob(user.id, file.id, spooled.size, spooled.path);
      deps.worker.notify();
      sendSuccess(res, { file, job }, {}, 202);
    } catch (err) {
      await fs.promises.rm(spooled.path, { force: true });
      throw err;
    }
  }));

  router.get("/files/:id", asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const file = await deps.files.getFileById(user.id, FileIdSchema.parse(req.params.id));
    if (!file) throw new AppError(ErrorCode.NOT_FOUND, "File not found", 404);
    sendSuccess(res, file);
  }));

  router.patch("/files/:id", asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const id = FileIdSchema.parse(req.params.id);
    const body = UpdateFileSchema.parse(req.body);
    sendSuccess(res, await deps.files.updateFile(user.id, id, { name: body.name, folderId: body.folder_id }));
  }));

  router.delete("/files/:id", asyncHandler(async (req, res) => {
    const user = requireUser(req);
    await deps.files.softDeleteFile(user.id, FileIdSchema.parse(req.params.id));
    sendSuccess(res, { trashed: true });
  }));

  router.post("/files/:id/restore", asyncHandler(async (req, res) => {
    const user = requireUser(req);
    sendSuccess(res, await deps.files.restoreFile(user.id, FileIdSchema.parse(req.params.id)));
  }));

  router.post("/files/:id/favorite", asyncHandler(async (req, res) => {
    const user = requireUser(req);
    sendSuccess(res, { isFavorite: await deps.files.toggleFavorite(user.id, FileIdSchema.parse(req.params.id)) });
  }));

  // Download / preview with HTTP Range support, streamed from the user's own Telegram storage.
  router.get("/files/:id/content", asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const id = FileIdSchema.parse(req.params.id);
    const query = ContentQuerySchema.parse(req.query);

    const file = await deps.files.getFileById(user.id, id);
    if (!file || file.deletedAt) throw new AppError(ErrorCode.NOT_FOUND, "File not found", 404);
    if (file.status !== "ready") throw new AppError(ErrorCode.CONFLICT, "File is not available yet (still uploading or failed)", 409);
    if (query.as === "text" && file.sizeBytes > MAX_TEXT_PREVIEW_BYTES) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "File is too large for a text preview", 413);
    }

    const stored = await deps.telegramObjects.getByFileId(user.id, id);
    if (!stored) throw new AppError(ErrorCode.STORAGE_UNAVAILABLE, "Storage record missing for this file", 500);
    // Peer-level isolation: the object must live in this user's own storage peer.
    if (stored.peerId !== (await deps.connector.peerIdFor(user.id))) {
      throw new AppError(ErrorCode.FORBIDDEN, "File is not stored in your storage", 403);
    }

    const size = file.sizeBytes;
    const range = parseRangeHeader(req.headers.range, size);
    if (range === "unsatisfiable") {
      res.setHeader("Content-Range", `bytes */${size}`);
      throw new AppError(ErrorCode.RANGE_NOT_SATISFIABLE, "Requested range not satisfiable", 416);
    }
    const start = range?.start ?? 0;
    const length = range ? range.end - range.start + 1 : size;

    const served = resolveServedContentType(file.mimeType, { asText: query.as === "text", attachment: query.disposition === "attachment" });
    const headers: Record<string, string | number> = {
      "Content-Type": served.contentType,
      "Content-Length": length,
      "Accept-Ranges": "bytes",
      "Content-Disposition": contentDispositionHeader(served.disposition, file.name),
      "Cache-Control": "private, max-age=0, must-revalidate",
      "X-Content-Type-Options": "nosniff"
    };
    // Content is opened in its own browsing context: no scripts, ever (PDF viewer needs an exception).
    if (served.contentType !== "application/pdf") {
      headers["Content-Security-Policy"] = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";
    }
    if (range) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;

    if (length === 0) {
      res.writeHead(range ? 206 : 200, headers).end();
      return;
    }

    const iterator = deps.connector
      .downloadStream(user.id, { ...stored, sizeBytes: size }, { offsetBytes: start, lengthBytes: length })
      [Symbol.asyncIterator]();
    // Pull the first chunk before committing headers so storage errors still become proper JSON errors.
    const first = await iterator.next();

    res.writeHead(range ? 206 : 200, headers);
    async function* body(): AsyncGenerator<Buffer> {
      if (!first.done) yield first.value;
      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    }
    try {
      await pipeline(Readable.from(body()), res);
    } catch (err) {
      // A viewer seeking, closing the tab or cancelling a download is normal, not an error. Anything
      // that fails while the client is still connected is a real problem and is logged.
      if (!isClientAbort(err)) {
        console.error(`[Download] Stream for ${id} failed:`, err instanceof Error ? err.message : err);
      }
      await iterator.return?.();
      res.destroy();
    }
  }));

  // ─── Trash (permanent deletion) ────────────────────────────────────────────

  const purge = async (userId: string, rootId?: string) => {
    const plan = await deps.files.planPurge(userId, rootId);
    // Delete from Telegram first; if that fails nothing is removed from the database.
    await deps.connector.executeDelete(userId, plan.objects);
    return deps.files.executePurge(userId, plan);
  };

  router.delete("/trash/:id", asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const id = FileIdSchema.or(FolderIdSchema).parse(req.params.id);
    sendSuccess(res, await purge(user.id, id));
  }));

  router.delete("/trash", asyncHandler(async (req, res) => {
    const user = requireUser(req);
    sendSuccess(res, await purge(user.id));
  }));

  // ─── Search, analytics, upload jobs ────────────────────────────────────────

  router.get("/search", asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const query = SearchQuerySchema.parse(req.query);
    const result = await deps.files.searchFiles(user.id, query.q, query.cursor, query.limit);
    sendSuccess(res, result.items, { next_cursor: result.nextCursor, total: result.total });
  }));

  router.get("/storage", asyncHandler(async (req, res) => {
    const user = requireUser(req);
    sendSuccess(res, await deps.files.getStorageAnalytics(user.id));
  }));

  router.get("/uploads/:id", asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const job = await deps.jobs.getJobById(user.id, JobIdSchema.parse(req.params.id));
    if (!job) throw new AppError(ErrorCode.NOT_FOUND, "Job not found", 404);
    sendSuccess(res, job);
  }));

  router.delete("/uploads/:id", asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const result = await deps.jobs.cancelQueued(user.id, JobIdSchema.parse(req.params.id));
    if (!result.cancelled) {
      throw new AppError(ErrorCode.CONFLICT, result.fileId ? "Upload already started or finished" : "Job not found", result.fileId ? 409 : 404);
    }
    if (result.tempPath) await fs.promises.rm(result.tempPath, { force: true });
    if (result.fileId) await deps.files.deleteFileRow(user.id, result.fileId);
    sendSuccess(res, { cancelled: true });
  }));

  return router;
}
