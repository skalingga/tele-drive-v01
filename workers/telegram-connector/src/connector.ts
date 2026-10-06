import type { StorageAdapter, StorageObject, UploadInput, DownloadOptions } from "@teledrive/storage";
import { LocalStorageAdapter } from "@teledrive/storage";
import type { UserRepository, TelegramObjectRepository } from "@teledrive/database";
import { AppError, ErrorCode, FloodWaitError, type StoragePeer } from "@teledrive/shared";
import {
  createTelegramClient,
  ensureStorageChannel,
  exportSession,
  mapTelegramError,
  TelegramStorageAdapter,
  type TelegramAdapterOptions,
  type TelegramAppCredentials
} from "@teledrive/telegram";
import { Api, type TelegramClient } from "telegram";
import type { SessionCrypto } from "./session-crypto.js";

export type StorageMode = "telegram" | "local";

export interface ConnectorOptions {
  mode: StorageMode;
  users: UserRepository;
  telegramObjects: TelegramObjectRepository;
  crypto: SessionCrypto;
  /** Required for mode "telegram" (and for QR login in any mode). */
  credentials?: TelegramAppCredentials;
  /** Directory for mode "local". */
  localStorageDir?: string;
  /** Test seam: supply the adapter for a user directly. */
  adapterFactory?: (userId: string) => Promise<StorageAdapter>;
  /** Tuning for the Telegram storage adapter (e.g. download prefetch depth). */
  adapterOptions?: TelegramAdapterOptions;
  maxUploadsPerUser?: number;
  maxDownloadsPerUser?: number;
  idleTimeoutMs?: number;
}

/** Per-user state: one MTProto client/adapter, its own FLOOD_WAIT window and transfer slots. */
interface Lane {
  adapter: StorageAdapter;
  client: TelegramClient | null;
  lastUsed: number;
  activeUploads: number;
  activeDownloads: number;
  uploadWaiters: (() => void)[];
  floodWaitUntil: number;
}

/**
 * The only component that talks MTProto (ADR-007). Holds one session per user (ADR-011);
 * a given session is only ever used from this process.
 */
export class TelegramConnectorService {
  private readonly lanes = new Map<string, Lane>();
  private readonly loading = new Map<string, Promise<Lane>>();
  private readonly maxUploads: number;
  private readonly maxDownloads: number;
  private readonly idleTimeoutMs: number;
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly options: ConnectorOptions) {
    if (options.mode === "telegram" && !options.credentials && !options.adapterFactory) {
      throw new Error("Telegram storage mode requires TELEGRAM_API_ID and TELEGRAM_API_HASH");
    }
    this.maxUploads = options.maxUploadsPerUser ?? 3;
    this.maxDownloads = options.maxDownloadsPerUser ?? 6;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 15 * 60 * 1000;
    this.sweeper = setInterval(() => void this.evictIdle(), 60 * 1000);
    this.sweeper.unref();
  }

  get credentials(): TelegramAppCredentials | undefined {
    return this.options.credentials;
  }

  get health(): { status: "healthy"; mode: StorageMode; connectedUsers: number } {
    return { status: "healthy", mode: this.options.mode, connectedUsers: this.lanes.size };
  }

  // ─── Lane management ─────────────────────────────────────────────────────

  private async lane(userId: string): Promise<Lane> {
    const existing = this.lanes.get(userId);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }
    let pending = this.loading.get(userId);
    if (!pending) {
      pending = this.openLane(userId).finally(() => this.loading.delete(userId));
      this.loading.set(userId, pending);
    }
    return pending;
  }

  private newLane(adapter: StorageAdapter, client: TelegramClient | null): Lane {
    return { adapter, client, lastUsed: Date.now(), activeUploads: 0, activeDownloads: 0, uploadWaiters: [], floodWaitUntil: 0 };
  }

  private async openLane(userId: string): Promise<Lane> {
    let lane: Lane;
    if (this.options.adapterFactory) {
      lane = this.newLane(await this.options.adapterFactory(userId), null);
    } else if (this.options.mode === "local") {
      lane = this.newLane(new LocalStorageAdapter(this.options.localStorageDir ?? "data/storage", `local_${userId}`), null);
    } else {
      const sessionEnc = await this.options.users.getSessionEnc(userId);
      if (!sessionEnc) {
        throw new AppError(ErrorCode.TELEGRAM_AUTH_REQUIRED, "Telegram session missing. Please log in again.", 401);
      }
      const client = createTelegramClient(this.options.credentials!, await this.decryptSession(userId, sessionEnc));
      try {
        await client.connect();
        let peer = await this.options.users.getStoragePeer(userId);
        if (!peer) {
          peer = await ensureStorageChannel(client, null);
          await this.options.users.setStoragePeer(userId, peer);
        }
        lane = this.newLane(this.telegramAdapter(client, peer), client);
      } catch (err) {
        await client.disconnect().catch(() => undefined);
        await this.handleError(userId, err);
        throw mapTelegramError(err);
      }
    }
    this.lanes.set(userId, lane);
    return lane;
  }

  /** Storage adapter for a connected user client. Download connections are extra clients on the same session. */
  private telegramAdapter(client: TelegramClient, peer: StoragePeer): TelegramStorageAdapter {
    const credentials = this.options.credentials!;
    return new TelegramStorageAdapter(client, peer, {
      ...this.options.adapterOptions,
      createExtraClient: async () => {
        const extra = createTelegramClient(credentials, exportSession(client));
        try {
          await extra.connect();
        } catch (err) {
          await extra.disconnect().catch(() => undefined);
          throw err;
        }
        return extra;
      }
    });
  }

  /**
   * Decrypts a stored session. If that fails (encryption key changed or lost, or the data is corrupt)
   * the session is unusable for good: the user is marked revoked so they are sent to the QR login,
   * instead of getting an opaque 500 on every request.
   */
  private async decryptSession(userId: string, sessionEnc: string): Promise<string> {
    try {
      return this.options.crypto.decrypt(sessionEnc);
    } catch {
      console.error(`[Connector] Stored Telegram session for ${userId} cannot be decrypted (TELEGRAM_SESSION_ENCRYPTION_KEY changed?). Requiring a new login.`);
      await this.options.users.markTelegramRevoked(userId);
      throw new AppError(ErrorCode.TELEGRAM_AUTH_REQUIRED, "Your Telegram session can no longer be used. Please log in again.", 401);
    }
  }

  /** Hands a freshly logged-in client to the pool (QR login), replacing any previous session. */
  async adoptClient(userId: string, client: TelegramClient, peer: StoragePeer): Promise<void> {
    const previous = this.lanes.get(userId);
    if (previous?.client && previous.client !== client) {
      // The old session is superseded — log it out so it doesn't linger in "Devices".
      await previous.client.invoke(new Api.auth.LogOut()).catch(() => undefined);
      await previous.adapter.close?.().catch(() => undefined);
      await previous.client.disconnect().catch(() => undefined);
    }
    if (this.options.mode === "telegram" && !this.options.adapterFactory) {
      this.lanes.set(userId, this.newLane(this.telegramAdapter(client, peer), client));
      return;
    }
    // Local/test storage: the session stays stored (for logout) but no live connection is needed.
    await client.disconnect().catch(() => undefined);
    this.lanes.delete(userId);
  }

  /** Storage peer id used for objects of this user (for building StorageObjects). */
  async peerIdFor(userId: string): Promise<string> {
    if (this.options.mode === "local" && !this.options.adapterFactory) return `local_${userId}`;
    const peer = await this.options.users.getStoragePeer(userId);
    return peer?.channelId ?? "";
  }

  private async dropLane(userId: string): Promise<void> {
    const lane = this.lanes.get(userId);
    this.lanes.delete(userId);
    await lane?.adapter.close?.().catch(() => undefined);
    await lane?.client?.disconnect().catch(() => undefined);
  }

  private async evictIdle(): Promise<void> {
    const now = Date.now();
    for (const [userId, lane] of this.lanes) {
      if (lane.activeUploads === 0 && lane.activeDownloads === 0 && now - lane.lastUsed > this.idleTimeoutMs) {
        await this.dropLane(userId);
      }
    }
  }

  // ─── Error / rate-limit handling ──────────────────────────────────────────

  private assertNotRateLimited(lane: Lane): void {
    const remainingMs = lane.floodWaitUntil - Date.now();
    if (remainingMs > 0) throw new FloodWaitError(Math.ceil(remainingMs / 1000));
  }

  /** Records FLOOD_WAIT on the user's lane; revokes the user if Telegram says the session is dead. */
  private async handleError(userId: string, err: unknown): Promise<Error> {
    const mapped = mapTelegramError(err);
    if (mapped instanceof FloodWaitError) {
      const lane = this.lanes.get(userId);
      if (lane) lane.floodWaitUntil = Math.max(lane.floodWaitUntil, Date.now() + mapped.seconds * 1000);
    } else if (mapped instanceof AppError && mapped.code === ErrorCode.TELEGRAM_AUTH_REQUIRED) {
      await this.dropLane(userId);
      await this.options.users.markTelegramRevoked(userId);
    }
    return mapped;
  }

  private async acquireUploadSlot(lane: Lane): Promise<void> {
    while (lane.activeUploads >= this.maxUploads) {
      await new Promise<void>(resolve => lane.uploadWaiters.push(resolve));
    }
    lane.activeUploads++;
  }

  private releaseUploadSlot(lane: Lane): void {
    lane.activeUploads--;
    lane.lastUsed = Date.now();
    lane.uploadWaiters.shift()?.();
  }

  // ─── Operations ───────────────────────────────────────────────────────────

  async executeUpload(userId: string, input: UploadInput): Promise<StorageObject> {
    const lane = await this.lane(userId);
    this.assertNotRateLimited(lane);
    await this.acquireUploadSlot(lane);
    try {
      return await lane.adapter.upload(input);
    } catch (err) {
      throw await this.handleError(userId, err);
    } finally {
      this.releaseUploadSlot(lane);
    }
  }

  /**
   * Streams an object. If Telegram reports an expired file_reference, the reference is
   * refreshed from the source message, persisted, and the download resumes where it stopped.
   */
  async *downloadStream(userId: string, object: StorageObject, options: DownloadOptions = {}): AsyncIterable<Buffer> {
    const lane = await this.lane(userId);
    this.assertNotRateLimited(lane);
    if (lane.activeDownloads >= this.maxDownloads) {
      throw new AppError(ErrorCode.RATE_LIMITED, "Too many concurrent downloads. Close other previews and retry.", 429);
    }
    lane.activeDownloads++;
    let current = object;
    let position = options.offsetBytes ?? 0;
    let remaining = options.lengthBytes;
    let refreshed = false;
    try {
      while (true) {
        try {
          for await (const chunk of lane.adapter.download(current, { offsetBytes: position, lengthBytes: remaining })) {
            position += chunk.length;
            if (remaining !== undefined) remaining -= chunk.length;
            lane.lastUsed = Date.now();
            yield chunk;
          }
          return;
        } catch (err) {
          const mapped = mapTelegramError(err);
          if (!refreshed && mapped instanceof AppError && mapped.code === ErrorCode.STORAGE_REFERENCE_EXPIRED) {
            refreshed = true;
            current = await this.refresh(userId, lane, current);
            continue;
          }
          throw await this.handleError(userId, mapped);
        }
      }
    } finally {
      lane.activeDownloads--;
      lane.lastUsed = Date.now();
    }
  }

  private async refresh(userId: string, lane: Lane, object: StorageObject): Promise<StorageObject> {
    try {
      const refreshed = await lane.adapter.refreshReference(object);
      await this.options.telegramObjects.updateFileReference(userId, object.fileId, refreshed.fileReference);
      return refreshed;
    } catch (err) {
      throw await this.handleError(userId, err);
    }
  }

  async executeRefresh(userId: string, object: StorageObject): Promise<StorageObject> {
    return this.refresh(userId, await this.lane(userId), object);
  }

  async executeDelete(userId: string, objects: StorageObject[]): Promise<void> {
    if (objects.length === 0) return;
    const lane = await this.lane(userId);
    this.assertNotRateLimited(lane);
    try {
      await lane.adapter.delete(objects);
    } catch (err) {
      throw await this.handleError(userId, err);
    }
  }

  async executeExists(userId: string, object: StorageObject): Promise<boolean> {
    const lane = await this.lane(userId);
    try {
      return await lane.adapter.exists(object);
    } catch (err) {
      throw await this.handleError(userId, err);
    }
  }

  /** Terminates the user's Telegram session (auth.logOut) and forgets the stored credential. */
  async logoutTelegram(userId: string): Promise<void> {
    let client = this.lanes.get(userId)?.client ?? null;
    if (!client && this.options.credentials) {
      const sessionEnc = await this.options.users.getSessionEnc(userId);
      if (sessionEnc) {
        // An undecryptable session cannot be logged out remotely; it is simply discarded below.
        const plain = await this.decryptSession(userId, sessionEnc).catch(() => null);
        if (plain !== null) {
          client = createTelegramClient(this.options.credentials, plain);
          await client.connect().catch(() => undefined);
        }
      }
    }
    if (client) await client.invoke(new Api.auth.LogOut()).catch(() => undefined);
    if (client && !this.lanes.has(userId)) await client.disconnect().catch(() => undefined);
    await this.dropLane(userId);
    await this.options.users.markTelegramRevoked(userId);
  }

  async shutdown(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.all([...this.lanes.keys()].map(userId => this.dropLane(userId)));
  }
}
