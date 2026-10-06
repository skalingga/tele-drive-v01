import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { AppError, ErrorCode } from "@teledrive/shared";
import type { StorageAdapter, StorageObject, UploadInput, DownloadOptions } from "./adapter.interface.js";

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Development/test adapter that stores objects on local disk under
 * `<baseDir>/<peerId>/<fileId>`. Bound to a single peer like the Telegram adapter.
 */
export class LocalStorageAdapter implements StorageAdapter {
  private readonly baseDir: string;

  constructor(baseDir: string, private readonly peerId: string) {
    if (!SAFE_SEGMENT.test(peerId)) throw new Error("Invalid peer id for local storage");
    this.baseDir = path.resolve(baseDir);
  }

  private objectPath(object: { peerId: string; fileId: string }): string {
    if (object.peerId !== this.peerId) {
      throw new AppError(ErrorCode.FORBIDDEN, "Storage object belongs to another peer", 403);
    }
    if (!SAFE_SEGMENT.test(object.fileId)) throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid file id", 400);
    return path.join(this.baseDir, this.peerId, object.fileId);
  }

  async upload(input: UploadInput): Promise<StorageObject> {
    const target = this.objectPath({ peerId: this.peerId, fileId: input.fileId });
    await fs.promises.mkdir(path.dirname(target), { recursive: true });

    let written = 0;
    const progress = new Transform({
      transform(chunk: Buffer, _enc, callback) {
        written += chunk.length;
        input.onProgress?.(written, input.sizeBytes);
        callback(null, chunk);
      }
    });
    const partial = `${target}.part`;
    await pipeline(fs.createReadStream(input.filePath), progress, fs.createWriteStream(partial));
    await fs.promises.rename(partial, target);

    return {
      fileId: input.fileId,
      peerId: this.peerId,
      messageId: Date.now(),
      documentId: `doc_${input.fileId}`,
      accessHash: `hash_${input.fileId}`,
      fileReference: Buffer.from(`ref_${input.fileId}_${Date.now()}`).toString("base64url"),
      dcId: 0,
      sizeBytes: written
    };
  }

  async *download(object: StorageObject, options?: DownloadOptions): AsyncIterable<Buffer> {
    const target = this.objectPath(object);
    if (!fs.existsSync(target)) {
      throw new AppError(ErrorCode.NOT_FOUND, "Stored object is missing", 404);
    }
    const start = options?.offsetBytes ?? 0;
    if (options?.lengthBytes === 0) return;
    const end = options?.lengthBytes !== undefined ? start + options.lengthBytes - 1 : undefined;
    for await (const chunk of fs.createReadStream(target, { start, end, highWaterMark: 64 * 1024 })) {
      yield chunk as Buffer;
    }
  }

  async delete(objects: StorageObject[]): Promise<void> {
    for (const object of objects) {
      await fs.promises.rm(this.objectPath(object), { force: true });
    }
  }

  async refreshReference(object: StorageObject): Promise<StorageObject> {
    return { ...object, fileReference: Buffer.from(`ref_${object.fileId}_${Date.now()}`).toString("base64url") };
  }

  async exists(object: StorageObject): Promise<boolean> {
    return fs.existsSync(this.objectPath(object));
  }
}
