import { AppError, ErrorCode, FloodWaitError } from "@teledrive/shared";

/** RPC errors meaning the user's MTProto session is no longer usable. */
const AUTH_LOST = [
  "AUTH_KEY_UNREGISTERED",
  "AUTH_KEY_INVALID",
  "AUTH_KEY_DUPLICATED",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "USER_DEACTIVATED",
  "USER_DEACTIVATED_BAN"
];

interface RpcLike {
  errorMessage?: string;
  message?: string;
  seconds?: number;
  code?: number;
}

/** Normalizes gramjs/RPC errors into AppErrors the rest of the system understands. */
export function mapTelegramError(err: unknown): Error {
  if (err instanceof AppError) return err;
  const e = (err ?? {}) as RpcLike;
  const text = `${e.errorMessage ?? ""} ${e.message ?? ""}`;

  const flood = /FLOOD(?:_PREMIUM)?_WAIT_?(\d+)|wait of (\d+) seconds/i.exec(text);
  if (flood || typeof e.seconds === "number") {
    const seconds = typeof e.seconds === "number" ? e.seconds : Number(flood?.[1] ?? flood?.[2] ?? 0);
    return new FloodWaitError(seconds);
  }
  if (AUTH_LOST.some(code => text.includes(code))) {
    return new AppError(ErrorCode.TELEGRAM_AUTH_REQUIRED, "Telegram session is no longer valid. Please log in again.", 401);
  }
  if (text.includes("FILE_REFERENCE_")) {
    return new AppError(ErrorCode.STORAGE_REFERENCE_EXPIRED, "Telegram file reference expired", 409);
  }
  if (/CHANNEL_INVALID|CHANNEL_PRIVATE|PEER_ID_INVALID/.test(text)) {
    return new AppError(ErrorCode.STORAGE_UNAVAILABLE, "TeleDrive storage channel is not accessible in your Telegram account", 503, { permanent: true });
  }
  if (/MESSAGE_ID_INVALID|MEDIA_EMPTY/.test(text)) {
    return new AppError(ErrorCode.NOT_FOUND, "The file no longer exists in Telegram", 404);
  }
  if (/TIMEOUT|ECONNRESET|ETIMEDOUT|ENOTFOUND|Not connected|disconnected/i.test(text)) {
    return new AppError(ErrorCode.STORAGE_UNAVAILABLE, "Telegram is temporarily unreachable", 503);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** Transient = worth retrying later with backoff. */
export function isTransientStorageError(err: unknown): boolean {
  if (err instanceof FloodWaitError) return true;
  if (!(err instanceof AppError) || err.code !== ErrorCode.STORAGE_UNAVAILABLE) return false;
  return !(err.details && typeof err.details === "object" && "permanent" in err.details);
}
