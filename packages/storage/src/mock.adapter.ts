import fs from "node:fs";
import { AppError, ErrorCode, FloodWaitError } from "@teledrive/shared";
import type { StorageAdapter, StorageObject, UploadInput, DownloadOptions } from "./adapter.interface.js";

/** In-memory adapter for tests, with failure injection. Intended for small fixtures only. */
export class MockStorageAdapter implements StorageAdapter {
  private memory = new Map<string, Buffer>();
  private references = new Map<string, string>();
  public shouldFailDownload = false;
  /** Next N downloads fail with STORAGE_REFERENCE_EXPIRED unless the reference was refreshed. */
  public simulateExpiredReference = false;
  /** Next download/upload fails with FLOOD_WAIT of this many seconds. */
  public simulateFloodWaitSeconds = 0;
  public uploadFailuresRemaining = 0;
  public refreshCount = 0;

  constructor(public readonly peerId: string = "mock_peer") {}

  private key(object: { fileId: string }): string {
    return `${this.peerId}:${object.fileId}`;
  }

  private takeFloodWait(): void {
    if (this.simulateFloodWaitSeconds > 0) {
      const secs = this.simulateFloodWaitSeconds;
      this.simulateFloodWaitSeconds = 0;
      throw new FloodWaitError(secs);
    }
  }

  async upload(input: UploadInput): Promise<StorageObject> {
    this.takeFloodWait();
    if (this.uploadFailuresRemaining > 0) {
      this.uploadFailuresRemaining--;
      throw new AppError(ErrorCode.STORAGE_UNAVAILABLE, "Simulated network failure", 503);
    }
    const buf = await fs.promises.readFile(input.filePath);
    this.memory.set(this.key(input), buf);
    const ref = `mock_ref_${Date.now()}`;
    this.references.set(this.key(input), ref);
    input.onProgress?.(buf.length, buf.length);
    return {
      fileId: input.fileId,
      peerId: this.peerId,
      messageId: this.memory.size,
      documentId: `mock_doc_${input.fileId}`,
      accessHash: `mock_hash_${input.fileId}`,
      fileReference: ref,
      dcId: 1,
      sizeBytes: buf.length
    };
  }

  async *download(object: StorageObject, options?: DownloadOptions): AsyncIterable<Buffer> {
    if (object.peerId !== this.peerId) throw new AppError(ErrorCode.FORBIDDEN, "Storage object belongs to another peer", 403);
    this.takeFloodWait();
    if (this.simulateExpiredReference && object.fileReference === this.references.get(this.key(object))) {
      throw new AppError(ErrorCode.STORAGE_REFERENCE_EXPIRED, "File reference expired", 409);
    }
    if (this.shouldFailDownload) {
      throw new AppError(ErrorCode.STORAGE_UNAVAILABLE, "Simulated storage disconnect failure", 503);
    }
    const buf = this.memory.get(this.key(object));
    if (!buf) throw new AppError(ErrorCode.NOT_FOUND, "Stored object is missing", 404);

    const start = options?.offsetBytes ?? 0;
    const end = options?.lengthBytes !== undefined ? start + options.lengthBytes : buf.length;
    const slice = buf.subarray(start, end);
    for (let i = 0; i < slice.length; i += 16 * 1024) {
      yield slice.subarray(i, i + 16 * 1024);
    }
  }

  async delete(objects: StorageObject[]): Promise<void> {
    for (const object of objects) this.memory.delete(this.key(object));
  }

  async refreshReference(object: StorageObject): Promise<StorageObject> {
    this.refreshCount++;
    return { ...object, fileReference: `mock_ref_refreshed_${this.refreshCount}` };
  }

  async exists(object: StorageObject): Promise<boolean> {
    return this.memory.has(this.key(object));
  }
}
