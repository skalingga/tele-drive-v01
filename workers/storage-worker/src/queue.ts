import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { JobRepository, FileRepository, TelegramObjectRepository, ClaimedJob } from "@teledrive/database";
import type { TelegramConnectorService } from "@teledrive/telegram-connector";
import { AppError, ErrorCode, FloodWaitError } from "@teledrive/shared";
import { isTransientStorageError } from "@teledrive/telegram";

export interface StorageWorkerOptions {
  jobs: JobRepository;
  files: FileRepository;
  telegramObjects: TelegramObjectRepository;
  connector: TelegramConnectorService;
  /** Directory where the web layer spools uploads before they are transferred. */
  tempDir: string;
  concurrency?: number;
  perUserConcurrency?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  pollIntervalMs?: number;
}

const ORPHAN_TEMP_AGE_MS = 60 * 60 * 1000;
const PROGRESS_WRITE_INTERVAL_MS = 500;

/**
 * Durable upload worker. Jobs live in the database, payloads on disk, so a crash or
 * restart resumes the queue instead of losing it (ADR-012).
 */
export class StorageWorker extends EventEmitter {
  private running = 0;
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly concurrency: number;
  private readonly perUser: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly pollIntervalMs: number;

  constructor(private readonly options: StorageWorkerOptions) {
    super();
    this.concurrency = options.concurrency ?? 4;
    this.perUser = options.perUserConcurrency ?? 2;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.baseBackoffMs = options.baseBackoffMs ?? 2000;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    fs.mkdirSync(this.options.tempDir, { recursive: true });
    const requeued = await this.options.jobs.requeueInterrupted();
    if (requeued > 0) console.info(`[StorageWorker] Re-queued ${requeued} interrupted job(s) after restart`);
    await this.sweepOrphanTempFiles();
    this.schedule(0);
  }

  /** Wake the worker immediately (call after enqueueing a job). */
  notify(): void {
    if (!this.stopped) this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.inFlight]);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      while (!this.stopped && this.running < this.concurrency) {
        const job = await this.options.jobs.claimNext(this.perUser);
        if (!job) break;
        this.running++;
        const task = this.process(job)
          .catch(err => console.error(`[StorageWorker] Unexpected error in job ${job.id}:`, err instanceof Error ? err.message : err))
          .finally(() => {
            this.running--;
            this.inFlight.delete(task);
            this.notify();
          });
        this.inFlight.add(task);
      }
    } finally {
      this.ticking = false;
      this.schedule(this.pollIntervalMs);
    }
  }

  private async removeTemp(tempPath: string | null): Promise<void> {
    if (tempPath) await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
  }

  private async process(job: ClaimedJob): Promise<void> {
    const { jobs, files, telegramObjects, connector } = this.options;

    const file = await files.getFileById(job.userId, job.fileId);
    if (!file) {
      await jobs.fail(job.id, "FILE_DELETED");
      await this.removeTemp(job.tempPath);
      return;
    }
    if (!job.tempPath || !fs.existsSync(job.tempPath)) {
      await jobs.fail(job.id, "UPLOAD_DATA_MISSING");
      await files.setStatus(job.userId, job.fileId, "failed");
      this.emit("job:failed", { jobId: job.id, error: "UPLOAD_DATA_MISSING" });
      return;
    }

    await files.setStatus(job.userId, job.fileId, "uploading");
    let lastProgressWrite = 0;

    try {
      const stored = await connector.executeUpload(job.userId, {
        fileId: job.fileId,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: job.totalBytes,
        filePath: job.tempPath,
        onProgress: uploaded => {
          const now = Date.now();
          if (now - lastProgressWrite < PROGRESS_WRITE_INTERVAL_MS) return;
          lastProgressWrite = now;
          void jobs.updateProgress(job.id, Math.min(uploaded, job.totalBytes));
          this.emit("job:progress", { jobId: job.id, progressBytes: uploaded, totalBytes: job.totalBytes });
        }
      });

      // The user may have permanently deleted the file while it was uploading.
      if (!(await files.getFileById(job.userId, job.fileId))) {
        await connector.executeDelete(job.userId, [stored]).catch(() => undefined);
        await jobs.fail(job.id, "FILE_DELETED");
        await this.removeTemp(job.tempPath);
        return;
      }

      await telegramObjects.saveObject({
        fileId: stored.fileId,
        peerId: stored.peerId,
        messageId: stored.messageId,
        documentId: stored.documentId,
        accessHash: stored.accessHash,
        fileReference: stored.fileReference,
        dcId: stored.dcId,
        createdAt: new Date().toISOString()
      });
      await files.setStatus(job.userId, job.fileId, "ready");
      await jobs.complete(job.id, job.totalBytes);
      await this.removeTemp(job.tempPath);
      this.emit("job:completed", job.id);
    } catch (err) {
      await this.handleFailure(job, err);
    }
  }

  private async handleFailure(job: ClaimedJob, err: unknown): Promise<void> {
    const { jobs, files } = this.options;
    const code = err instanceof AppError ? err.code : ErrorCode.UPLOAD_FAILED;

    if (code === ErrorCode.TELEGRAM_AUTH_REQUIRED) {
      // Session is gone: nothing for this user can upload until they log in again.
      const { fileIds, tempPaths } = await jobs.failAllOpenForUser(job.userId, code);
      for (const fileId of new Set([...fileIds, job.fileId])) await files.setStatus(job.userId, fileId, "failed");
      for (const p of new Set([...tempPaths, job.tempPath])) await this.removeTemp(p);
      this.emit("job:failed", { jobId: job.id, error: code });
      return;
    }

    if (isTransientStorageError(err) && job.attempts < this.maxAttempts) {
      const backoff = Math.min(this.baseBackoffMs * 2 ** (job.attempts - 1), 5 * 60 * 1000);
      // Honour Telegram's FLOOD_WAIT instead of retrying into it.
      const delayMs = err instanceof FloodWaitError ? Math.max(backoff, err.seconds * 1000 + 1000) : backoff;
      console.warn(`[StorageWorker] Job ${job.id} attempt ${job.attempts}/${this.maxAttempts} failed (${code}); retrying in ${Math.round(delayMs / 1000)}s`);
      await jobs.reschedule(job.id, delayMs, code);
      await files.setStatus(job.userId, job.fileId, "pending");
      this.emit("job:retry", { jobId: job.id, delayMs });
      return;
    }

    console.error(`[StorageWorker] Job ${job.id} failed permanently after ${job.attempts} attempt(s): ${code}`);
    await jobs.fail(job.id, code);
    await files.setStatus(job.userId, job.fileId, "failed");
    await this.removeTemp(job.tempPath);
    this.emit("job:failed", { jobId: job.id, error: code });
  }

  /** Deletes spooled files no job refers to (e.g. an HTTP upload that crashed mid-way). */
  private async sweepOrphanTempFiles(): Promise<void> {
    const live = await this.options.jobs.liveTempPaths();
    const entries = await fs.promises.readdir(this.options.tempDir).catch(() => [] as string[]);
    const now = Date.now();
    for (const name of entries) {
      const full = path.join(this.options.tempDir, name);
      if (live.has(full)) continue;
      const stat = await fs.promises.stat(full).catch(() => null);
      if (stat?.isFile() && now - stat.mtimeMs > ORPHAN_TEMP_AGE_MS) {
        await fs.promises.rm(full, { force: true }).catch(() => undefined);
      }
    }
  }
}
