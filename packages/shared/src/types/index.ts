import { ErrorCode } from "../errors/codes.js";

/** Telegram connection state of a user's MTProto session. */
export type TelegramStatus = "active" | "revoked";

/**
 * A TeleDrive user is exactly one Telegram account (ADR-011).
 * Identity comes from Telegram QR login — there is no email/password.
 */
export interface User {
  id: string;
  telegramUserId: string;
  displayName: string;
  username: string | null;
  telegramStatus: TelegramStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}

/** The private channel inside the user's own Telegram account that holds their files. */
export interface StoragePeer {
  channelId: string;
  accessHash: string;
}

export interface Folder {
  id: string;
  userId: string;
  parentId: string | null;
  name: string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type FileStatus = "pending" | "uploading" | "ready" | "failed" | "cancelled";

export interface FileItem {
  id: string;
  userId: string;
  folderId: string | null;
  name: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string | null;
  status: FileStatus;
  isFavorite?: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramObject {
  fileId: string;
  /** Channel id of the owner's storage peer — must match the user's StoragePeer (peer-level check). */
  peerId: string;
  messageId: number;
  documentId: string;
  accessHash: string;
  fileReference: string;
  dcId: number;
  createdAt: string;
}

export type JobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

export interface TransferJob {
  id: string;
  userId: string;
  fileId: string;
  status: JobStatus;
  progressBytes: number;
  totalBytes: number;
  attempts: number;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StorageAnalytics {
  totalFiles: number;
  totalFolders: number;
  usedBytes: number;
  formattedUsed: string;
  status: "active" | "warning";
}

export type QrLoginState =
  | { status: "waiting"; qrUrl: string; expiresAt: string }
  | { status: "password_required"; hint: string | null; passwordError: string | null }
  | { status: "success" }
  | { status: "expired" }
  | { status: "failed"; message: string };

export interface ApiResponse<T = unknown> {
  data: T | null;
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  } | null;
  meta: {
    next_cursor?: string | null;
    total?: number;
    [key: string]: unknown;
  };
}
