import crypto from "node:crypto";
import type { TransferJob, JobStatus } from "@teledrive/shared";
import { Database, nowIso } from "./db.js";

interface JobRow {
  id: string;
  user_id: string;
  file_id: string;
  status: JobStatus;
  progress_bytes: number;
  total_bytes: number;
  attempts: number;
  error_code: string | null;
  temp_path: string | null;
  run_after: string;
  created_at: string;
  updated_at: string;
}

function toJob(row: JobRow): TransferJob {
  return {
    id: row.id,
    userId: row.user_id,
    fileId: row.file_id,
    status: row.status,
    progressBytes: row.progress_bytes,
    totalBytes: row.total_bytes,
    attempts: row.attempts,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** Server-side view of a job, including the spooled temp file. Never sent to clients. */
export interface ClaimedJob extends TransferJob {
  tempPath: string | null;
}

export class JobRepository {
  constructor(private db: Database) {}

  async createJob(userId: string, fileId: string, totalBytes: number, tempPath: string): Promise<TransferJob> {
    const now = nowIso();
    const id = `job_${crypto.randomUUID()}`;
    this.db.run(
      `INSERT INTO jobs (id, user_id, file_id, status, total_bytes, temp_path, run_after, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
      id, userId, fileId, totalBytes, tempPath, now, now, now
    );
    return toJob(this.db.get<JobRow>("SELECT * FROM jobs WHERE id = ?", id)!);
  }

  /** Row-level scoped lookup for the API. */
  async getJobById(userId: string, jobId: string): Promise<TransferJob | null> {
    const row = this.db.get<JobRow>("SELECT * FROM jobs WHERE id = ? AND user_id = ?", jobId, userId);
    return row ? toJob(row) : null;
  }

  async countOpenJobs(userId: string): Promise<number> {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND status IN ('queued', 'processing')", userId)!.n;
  }

  /**
   * Atomically claims the oldest runnable job, skipping users that already have
   * `perUserLimit` jobs in flight.
   */
  async claimNext(perUserLimit: number): Promise<ClaimedJob | null> {
    return this.db.transaction(() => {
      const row = this.db.get<JobRow>(
        `SELECT j.* FROM jobs j
         WHERE j.status = 'queued' AND j.run_after <= ?
           AND (SELECT COUNT(*) FROM jobs p WHERE p.user_id = j.user_id AND p.status = 'processing') < ?
         ORDER BY j.run_after ASC, j.created_at ASC
         LIMIT 1`,
        nowIso(), perUserLimit
      );
      if (!row) return null;
      this.db.run("UPDATE jobs SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ?", nowIso(), row.id);
      const claimed = this.db.get<JobRow>("SELECT * FROM jobs WHERE id = ?", row.id)!;
      return { ...toJob(claimed), tempPath: claimed.temp_path };
    });
  }

  async updateProgress(jobId: string, progressBytes: number): Promise<void> {
    this.db.run("UPDATE jobs SET progress_bytes = ?, updated_at = ? WHERE id = ? AND status = 'processing'", progressBytes, nowIso(), jobId);
  }

  async complete(jobId: string, totalBytes: number): Promise<void> {
    this.db.run(
      "UPDATE jobs SET status = 'completed', progress_bytes = ?, error_code = NULL, temp_path = NULL, updated_at = ? WHERE id = ?",
      totalBytes, nowIso(), jobId
    );
  }

  async fail(jobId: string, errorCode: string): Promise<void> {
    this.db.run("UPDATE jobs SET status = 'failed', error_code = ?, temp_path = NULL, updated_at = ? WHERE id = ?", errorCode, nowIso(), jobId);
  }

  /** Puts a job back in the queue to retry no earlier than `delayMs` from now. */
  async reschedule(jobId: string, delayMs: number, errorCode: string): Promise<void> {
    const now = Date.now();
    this.db.run(
      "UPDATE jobs SET status = 'queued', error_code = ?, run_after = ?, updated_at = ? WHERE id = ? AND status = 'processing'",
      errorCode, new Date(now + delayMs).toISOString(), new Date(now).toISOString(), jobId
    );
  }

  /** Cancels a job that has not started yet. Returns the temp file to clean up. */
  async cancelQueued(userId: string, jobId: string): Promise<{ cancelled: boolean; fileId: string | null; tempPath: string | null }> {
    return this.db.transaction(() => {
      const row = this.db.get<JobRow>("SELECT * FROM jobs WHERE id = ? AND user_id = ?", jobId, userId);
      if (!row || row.status !== "queued") return { cancelled: false, fileId: row?.file_id ?? null, tempPath: null };
      this.db.run("UPDATE jobs SET status = 'cancelled', temp_path = NULL, updated_at = ? WHERE id = ?", nowIso(), jobId);
      return { cancelled: true, fileId: row.file_id, tempPath: row.temp_path };
    });
  }

  /** After a crash/restart: jobs that were mid-flight go back to the queue. */
  async requeueInterrupted(): Promise<number> {
    return this.db.run("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'processing'", nowIso()).changes;
  }

  /** Temp files that are still referenced by unfinished jobs (used to sweep orphans). */
  async liveTempPaths(): Promise<Set<string>> {
    const rows = this.db.all<{ temp_path: string }>("SELECT temp_path FROM jobs WHERE temp_path IS NOT NULL AND status IN ('queued', 'processing')");
    return new Set(rows.map(r => r.temp_path));
  }

  /** Fails all open jobs of a user (e.g. Telegram session revoked). Returns their temp files. */
  async failAllOpenForUser(userId: string, errorCode: string): Promise<{ fileIds: string[]; tempPaths: string[] }> {
    return this.db.transaction(() => {
      const rows = this.db.all<JobRow>("SELECT * FROM jobs WHERE user_id = ? AND status IN ('queued', 'processing')", userId);
      this.db.run(
        "UPDATE jobs SET status = 'failed', error_code = ?, temp_path = NULL, updated_at = ? WHERE user_id = ? AND status IN ('queued', 'processing')",
        errorCode, nowIso(), userId
      );
      return {
        fileIds: rows.map(r => r.file_id),
        tempPaths: rows.map(r => r.temp_path).filter((p): p is string => p !== null)
      };
    });
  }
}
