import crypto from "node:crypto";
import type { User, QrLoginState } from "@teledrive/shared";
import { AppError, ErrorCode } from "@teledrive/shared";
import type { UserRepository } from "@teledrive/database";
import { QrLoginAttempt, ensureStorageChannel, exportSession, getProfile, type TelegramAppCredentials } from "@teledrive/telegram";
import type { TelegramConnectorService } from "./connector.js";
import type { SessionCrypto } from "./session-crypto.js";

/** What the web layer needs from a QR login provider (lets tests substitute a fake). */
export interface QrLoginProvider {
  start(): { attemptId: string; browserSecret: string };
  status(attemptId: string, browserSecret: string): Promise<{ state: QrLoginState; user: User | null }>;
  submitPassword(attemptId: string, browserSecret: string, password: string): void;
  cancel(attemptId: string, browserSecret: string): Promise<void>;
  readonly activeAttempts: number;
}

interface AttemptEntry {
  attempt: QrLoginAttempt;
  secretHash: Buffer;
  createdAt: number;
  finalize: Promise<User> | null;
}

const MAX_ATTEMPTS = 100;
const ENTRY_TTL_MS = 6 * 60 * 1000;

function hashSecret(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret).digest();
}

/**
 * Runs Telegram QR logins. Each attempt is bound to the browser that started it via a
 * random secret (kept in an httpOnly cookie), so a leaked attempt id is useless on its own.
 */
export class QrLoginService implements QrLoginProvider {
  private readonly attempts = new Map<string, AttemptEntry>();

  constructor(
    private readonly credentials: TelegramAppCredentials,
    private readonly connector: TelegramConnectorService,
    private readonly users: UserRepository,
    private readonly crypto: SessionCrypto
  ) {}

  get activeAttempts(): number {
    return this.attempts.size;
  }

  start(): { attemptId: string; browserSecret: string } {
    this.sweep();
    if (this.attempts.size >= MAX_ATTEMPTS) {
      throw new AppError(ErrorCode.RATE_LIMITED, "Too many login attempts in progress. Try again in a minute.", 429);
    }
    const attemptId = `qr_${crypto.randomBytes(18).toString("base64url")}`;
    const browserSecret = crypto.randomBytes(32).toString("base64url");
    this.attempts.set(attemptId, {
      attempt: new QrLoginAttempt(this.credentials),
      secretHash: hashSecret(browserSecret),
      createdAt: Date.now(),
      finalize: null
    });
    return { attemptId, browserSecret };
  }

  private entry(attemptId: string, browserSecret: string): AttemptEntry {
    const entry = this.attempts.get(attemptId);
    if (!entry || !crypto.timingSafeEqual(entry.secretHash, hashSecret(browserSecret))) {
      throw new AppError(ErrorCode.NOT_FOUND, "Login attempt not found or expired", 404);
    }
    return entry;
  }

  async status(attemptId: string, browserSecret: string): Promise<{ state: QrLoginState; user: User | null }> {
    const entry = this.entry(attemptId, browserSecret);
    const phase = entry.attempt.phase;
    switch (phase.phase) {
      case "starting":
        return { state: { status: "waiting", qrUrl: "", expiresAt: new Date().toISOString() }, user: null };
      case "waiting":
        return { state: { status: "waiting", qrUrl: phase.qrUrl, expiresAt: phase.expiresAt.toISOString() }, user: null };
      case "password_required":
        return { state: { status: "password_required", hint: phase.hint, passwordError: phase.passwordError }, user: null };
      case "expired":
        this.attempts.delete(attemptId);
        return { state: { status: "expired" }, user: null };
      case "failed":
        this.attempts.delete(attemptId);
        return { state: { status: "failed", message: "Login Telegram gagal. Silakan coba lagi." }, user: null };
      case "success": {
        entry.finalize ??= this.finalize(entry.attempt);
        try {
          const user = await entry.finalize;
          this.attempts.delete(attemptId);
          return { state: { status: "success" }, user };
        } catch (err) {
          this.attempts.delete(attemptId);
          await entry.attempt.client.disconnect().catch(() => undefined);
          console.error("[QrLogin] Finalizing login failed:", err instanceof Error ? err.message : "unknown error");
          return { state: { status: "failed", message: "Login berhasil di Telegram, tetapi penyiapan penyimpanan gagal. Coba lagi." }, user: null };
        }
      }
    }
  }

  /** Persists the user + encrypted session, provisions the storage channel, and hands the client to the pool. */
  private async finalize(attempt: QrLoginAttempt): Promise<User> {
    const client = attempt.client;
    const profile = await getProfile(client);
    const user = await this.users.upsertFromTelegram({
      ...profile,
      sessionEnc: this.crypto.encrypt(exportSession(client))
    });
    const peer = await ensureStorageChannel(client, await this.users.getStoragePeer(user.id));
    await this.users.setStoragePeer(user.id, peer);
    await this.connector.adoptClient(user.id, client, peer);
    return user;
  }

  submitPassword(attemptId: string, browserSecret: string, password: string): void {
    const entry = this.entry(attemptId, browserSecret);
    if (!entry.attempt.submitPassword(password)) {
      throw new AppError(ErrorCode.CONFLICT, "This login attempt is not waiting for a password", 409);
    }
  }

  async cancel(attemptId: string, browserSecret: string): Promise<void> {
    const entry = this.entry(attemptId, browserSecret);
    this.attempts.delete(attemptId);
    await entry.attempt.cancel();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.attempts) {
      if (now - entry.createdAt > ENTRY_TTL_MS && !entry.finalize) {
        this.attempts.delete(id);
        void entry.attempt.cancel();
      }
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.attempts.values()].map(e => e.attempt.cancel()));
    this.attempts.clear();
  }
}
