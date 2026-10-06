import type { StorageAdapter, StorageObject, UploadInput, DownloadOptions } from "@teledrive/storage";
import { AppError, ErrorCode, type StoragePeer } from "@teledrive/shared";
import { Api, type TelegramClient } from "telegram";
import { CustomFile } from "telegram/client/uploads.js";
import bigInt from "big-integer";
import { mapTelegramError } from "./errors.js";
import { DownloadConnectionPool } from "./download-pool.js";

/**
 * upload.getFile constraints: offset and limit are multiples of 4 KiB, limit <= 1 MiB, and a request
 * may not cross a 1 MiB boundary — so the chunk size must divide 1 MiB.
 * (gramjs' own iterDownload caps requests at 512 KiB and fetches them one after another.)
 */
export const DEFAULT_DOWNLOAD_CHUNK_BYTES = 256 * 1024;
export const DEFAULT_DOWNLOAD_CONNECTIONS = 4;
const MAX_DOWNLOAD_CONNECTIONS = 8;
/** Chunks in flight per connection; keeps every connection busy while the consumer drains in order. */
const CHUNKS_IN_FLIGHT_PER_CONNECTION = 3;
/** Downloads needing fewer chunks per connection than this don't open extra connections. */
const MIN_CHUNKS_PER_CONNECTION = 4;
const TIMEOUT_RETRY_DELAY_MS = 1000;
const MAX_FETCH_ATTEMPTS = 5;

export interface TelegramAdapterOptions {
  /**
   * Parallel download connections per user (1-8, default 4), opened in addition to the main one.
   * Telegram throttles each connection, so throughput scales roughly linearly with this up to the
   * user's own bandwidth.
   */
  connections?: number;
  /** Opens one more connected client on the same session; without it only the main connection is used. */
  createExtraClient?: () => Promise<TelegramClient>;
  /** Request size in bytes; must divide 1 MiB and be a multiple of 4 KiB. Default 256 KiB. */
  chunkBytes?: number;
  /** Max chunks requested ahead of the consumer. Default: connections in use x 3. */
  prefetchChunks?: number;
  /** Idle time before the extra connections are closed. Default 60 s. */
  idleMs?: number;
}

interface DownloadContext {
  location: Api.InputDocumentFileLocation;
  /** Data center holding the file; updated if Telegram answers FILE_MIGRATE. */
  dcId: number;
  chunk: number;
  /** Big download: use the pooled connections, keeping the main one free for uploads. */
  bulk: boolean;
}

function rpcText(err: unknown): string {
  const e = (err ?? {}) as { errorMessage?: string; message?: string };
  return `${e.errorMessage ?? ""} ${e.message ?? ""}`;
}

function migrateTarget(err: unknown): number | null {
  const e = (err ?? {}) as { newDc?: unknown };
  if (typeof e.newDc === "number" && e.newDc > 0) return e.newDc;
  const m = /FILE_MIGRATE_(\d+)/.exec(rpcText(err));
  return m ? Number(m[1]) : null;
}

/** The connection itself is gone (as opposed to Telegram answering with an error). */
function isConnectionLoss(err: unknown): boolean {
  return /Not connected|disconnect|connection (?:closed|reset)|ECONNRESET|EPIPE|socket/i.test(rpcText(err));
}

function validChunkBytes(value: number | undefined): number {
  const MB = 1024 * 1024;
  if (value === undefined) return DEFAULT_DOWNLOAD_CHUNK_BYTES;
  if (!Number.isInteger(value) || value < 4096 || value > MB || value % 4096 !== 0 || MB % value !== 0) {
    throw new Error("chunkBytes must be a multiple of 4096 that divides 1 MiB");
  }
  return value;
}

/**
 * Stores files as documents in ONE user's private storage channel, using that user's
 * own MTProto session. Every object is checked against the bound channel (peer-level isolation).
 */
export class TelegramStorageAdapter implements StorageAdapter {
  private readonly inputPeer: Api.InputPeerChannel;
  private readonly connections: number;
  private readonly chunkBytes: number;
  private readonly prefetchOverride: number | undefined;
  private readonly pool: DownloadConnectionPool;

  constructor(private readonly client: TelegramClient, private readonly peer: StoragePeer, options: TelegramAdapterOptions = {}) {
    this.connections = Math.min(Math.max(Math.floor(options.connections ?? DEFAULT_DOWNLOAD_CONNECTIONS), 1), MAX_DOWNLOAD_CONNECTIONS);
    this.chunkBytes = validChunkBytes(options.chunkBytes);
    this.prefetchOverride = options.prefetchChunks === undefined ? undefined : Math.min(Math.max(Math.floor(options.prefetchChunks), 1), 64);
    this.pool = new DownloadConnectionPool(client, {
      maxConnections: this.connections,
      factory: options.createExtraClient,
      idleMs: options.idleMs
    });
    this.inputPeer = new Api.InputPeerChannel({
      channelId: bigInt(peer.channelId),
      accessHash: bigInt(peer.accessHash)
    });
  }

  private assertOwnPeer(object: StorageObject): void {
    if (object.peerId !== this.peer.channelId) {
      throw new AppError(ErrorCode.FORBIDDEN, "Storage object does not belong to this user's Telegram storage", 403);
    }
  }

  async upload(input: UploadInput): Promise<StorageObject> {
    try {
      const message = await this.client.sendFile(this.inputPeer, {
        // CustomFile with a path: gramjs reads parts from disk for large files instead of buffering.
        file: new CustomFile(input.name, input.sizeBytes, input.filePath),
        forceDocument: true,
        workers: 4,
        attributes: [new Api.DocumentAttributeFilename({ fileName: input.name })],
        progressCallback: (fraction: number) => {
          input.onProgress?.(Math.round(fraction * input.sizeBytes), input.sizeBytes);
        }
      });

      const media = message.media;
      const doc = media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document ? media.document : null;
      if (!doc) throw new AppError(ErrorCode.UPLOAD_FAILED, "Telegram did not return a document for the upload", 502);

      return {
        fileId: input.fileId,
        peerId: this.peer.channelId,
        messageId: message.id,
        documentId: doc.id.toString(),
        accessHash: doc.accessHash.toString(),
        fileReference: Buffer.from(doc.fileReference).toString("base64url"),
        dcId: doc.dcId,
        sizeBytes: Number(doc.size.toString())
      };
    } catch (err) {
      throw mapTelegramError(err);
    }
  }

  /**
   * Streams [offset, offset+length) of a document. Aligned chunks are requested in parallel across
   * the user's download connections and delivered strictly in order, then trimmed, so arbitrary HTTP
   * Range requests work. Buffered data is bounded by the prefetch window: a slow consumer simply
   * stops new requests.
   */
  async *download(object: StorageObject, options?: DownloadOptions): AsyncIterable<Buffer> {
    this.assertOwnPeer(object);
    const start = options?.offsetBytes ?? 0;
    const size = object.sizeBytes;
    let remaining = options?.lengthBytes ?? (size !== undefined ? size - start : Number.POSITIVE_INFINITY);
    if (remaining <= 0) return;

    const chunkSize = this.chunkBytes;
    const alignedStart = Math.floor(start / chunkSize) * chunkSize;
    let skip = start - alignedStart;
    // With a known length we never request past it; otherwise we stop at the first short chunk.
    const totalChunks = Number.isFinite(remaining) ? Math.ceil((skip + remaining) / chunkSize) : Number.POSITIVE_INFINITY;

    // Small downloads (a thumbnail, a document, a tiny seek) stay on the main connection and don't pay
    // for new ones. Bigger ones run on pooled connections only, so they never starve uploads.
    const wanted = Number.isFinite(totalChunks)
      ? Math.min(this.connections, Math.max(1, Math.ceil(totalChunks / MIN_CHUNKS_PER_CONNECTION)))
      : this.connections;
    const bulk = wanted >= 2;
    if (bulk) await this.pool.ensure(wanted).catch(() => undefined); // best effort: the main connection is the fallback
    const lanes = bulk && this.pool.size > 0 ? Math.min(wanted, this.pool.size) : 1;
    const inFlight = this.prefetchOverride ?? Math.max(2, lanes * CHUNKS_IN_FLIGHT_PER_CONNECTION);

    const ctx: DownloadContext = {
      location: new Api.InputDocumentFileLocation({
        id: bigInt(object.documentId),
        accessHash: bigInt(object.accessHash),
        fileReference: Buffer.from(object.fileReference, "base64url"),
        thumbSize: ""
      }),
      dcId: object.dcId,
      chunk: chunkSize,
      bulk
    };

    const window: Promise<Buffer>[] = [];
    let nextChunk = 0;
    let reachedEnd = false;
    const fill = () => {
      while (!reachedEnd && window.length < inFlight && nextChunk < totalChunks) {
        const pending = this.fetchChunk(ctx, alignedStart + nextChunk * chunkSize);
        pending.catch(() => undefined); // surfaced when its turn comes; never an unhandled rejection
        window.push(pending);
        nextChunk++;
      }
    };

    try {
      fill();
      while (window.length > 0) {
        let chunk = await window.shift()!;
        if (chunk.length < chunkSize) reachedEnd = true; // short chunk = end of the document
        fill();

        if (skip > 0) {
          chunk = chunk.subarray(skip);
          skip = 0;
        }
        if (chunk.length > remaining) chunk = chunk.subarray(0, remaining);
        if (chunk.length > 0) {
          remaining -= chunk.length;
          yield chunk;
        }
        if (remaining <= 0 || reachedEnd) return;
      }
    } catch (err) {
      throw mapTelegramError(err);
    } finally {
      window.length = 0;
    }
  }

  /**
   * One upload.getFile request on the least busy connection. Retries a TIMEOUT once, follows
   * FILE_MIGRATE to the right data center, and moves on from a pooled connection that died.
   */
  private async fetchChunk(ctx: DownloadContext, offset: number): Promise<Buffer> {
    let timedOut = false;
    for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt++) {
      const lease = this.pool.lease(ctx.bulk);
      try {
        const sender = await lease.client.getSender(ctx.dcId);
        const result = await lease.client.invokeWithSender(
          new Api.upload.GetFile({ location: ctx.location, offset: bigInt(offset), limit: ctx.chunk, precise: false }),
          sender
        );
        if (result instanceof Api.upload.FileCdnRedirect) {
          throw new AppError(ErrorCode.STORAGE_UNAVAILABLE, "Telegram redirected the download to a CDN, which is not supported", 502, { permanent: true });
        }
        return Buffer.from((result as Api.upload.File).bytes);
      } catch (err) {
        const dc = migrateTarget(err);
        if (dc !== null) {
          ctx.dcId = dc;
          continue;
        }
        if (lease.isExtra && isConnectionLoss(err)) {
          this.pool.evict(lease.client);
          continue;
        }
        if (!timedOut && /\bTIMEOUT\b/.test(rpcText(err))) {
          timedOut = true;
          await new Promise(resolve => setTimeout(resolve, TIMEOUT_RETRY_DELAY_MS));
          continue;
        }
        throw err;
      } finally {
        lease.release();
      }
    }
    throw new AppError(ErrorCode.STORAGE_UNAVAILABLE, "Telegram download kept failing across connections or data centers", 503);
  }

  async delete(objects: StorageObject[]): Promise<void> {
    for (const object of objects) this.assertOwnPeer(object);
    const ids = objects.map(o => o.messageId);
    try {
      for (let i = 0; i < ids.length; i += 100) {
        await this.client.deleteMessages(this.inputPeer, ids.slice(i, i + 100), { revoke: true });
      }
    } catch (err) {
      throw mapTelegramError(err);
    }
  }

  async refreshReference(object: StorageObject): Promise<StorageObject> {
    this.assertOwnPeer(object);
    const doc = await this.fetchDocument(object.messageId);
    if (!doc) throw new AppError(ErrorCode.NOT_FOUND, "The file no longer exists in Telegram", 404);
    return { ...object, fileReference: Buffer.from(doc.fileReference).toString("base64url") };
  }

  async exists(object: StorageObject): Promise<boolean> {
    this.assertOwnPeer(object);
    return (await this.fetchDocument(object.messageId)) !== null;
  }

  /** Closes the extra download connections. The main client belongs to the connector. */
  async close(): Promise<void> {
    await this.pool.close();
  }

  private async fetchDocument(messageId: number): Promise<Api.Document | null> {
    try {
      const [message] = await this.client.getMessages(this.inputPeer, { ids: [messageId] });
      const media = message?.media;
      return media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document ? media.document : null;
    } catch (err) {
      throw mapTelegramError(err);
    }
  }
}
