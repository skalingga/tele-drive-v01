export interface UploadInput {
  fileId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /**
   * Path of the spooled upload on local disk. Adapters must stream from it
   * (never read the whole file into memory).
   */
  filePath: string;
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
}

export interface StorageObject {
  fileId: string;
  /** Storage peer (Telegram channel id) the object lives in. */
  peerId: string;
  messageId: number;
  documentId: string;
  accessHash: string;
  fileReference: string;
  dcId: number;
  sizeBytes?: number;
}

export interface DownloadOptions {
  offsetBytes?: number;
  /** Number of bytes to return; omitted = until the end of the object. */
  lengthBytes?: number;
}

/**
 * Storage contract. An adapter instance is bound to exactly one user's storage peer;
 * the connector creates one per user, so implementations never pick a peer themselves.
 */
export interface StorageAdapter {
  upload(input: UploadInput): Promise<StorageObject>;
  download(object: StorageObject, options?: DownloadOptions): AsyncIterable<Buffer>;
  delete(objects: StorageObject[]): Promise<void>;
  refreshReference(object: StorageObject): Promise<StorageObject>;
  exists(object: StorageObject): Promise<boolean>;
  /** Releases resources the adapter owns (e.g. extra connections). Called when the user's lane is dropped. */
  close?(): Promise<void>;
}
