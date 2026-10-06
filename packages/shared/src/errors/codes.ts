export enum ErrorCode {
  AUTH_REQUIRED = "AUTH_REQUIRED",
  /** The user's Telegram session was revoked or expired — a new QR login is required. */
  TELEGRAM_AUTH_REQUIRED = "TELEGRAM_AUTH_REQUIRED",
  FORBIDDEN = "FORBIDDEN",
  NOT_FOUND = "NOT_FOUND",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  UPLOAD_FAILED = "UPLOAD_FAILED",
  STORAGE_REFERENCE_EXPIRED = "STORAGE_REFERENCE_EXPIRED",
  STORAGE_RATE_LIMITED = "STORAGE_RATE_LIMITED",
  STORAGE_UNAVAILABLE = "STORAGE_UNAVAILABLE",
  RANGE_NOT_SATISFIABLE = "RANGE_NOT_SATISFIABLE",
  RATE_LIMITED = "RATE_LIMITED",
  CONFLICT = "CONFLICT",
  INTERNAL_ERROR = "INTERNAL_ERROR"
}

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details: unknown;

  constructor(code: ErrorCode, message: string, statusCode: number = 400, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details ?? null;
  }
}

/** Telegram FLOOD_WAIT surfaced to callers, carrying the wait Telegram asked for. */
export class FloodWaitError extends AppError {
  public readonly seconds: number;

  constructor(seconds: number) {
    super(ErrorCode.STORAGE_RATE_LIMITED, `Telegram rate limit (FLOOD_WAIT). Retry in ${seconds}s.`, 429, { retryAfterSeconds: seconds });
    this.name = "FloodWaitError";
    this.seconds = seconds;
  }
}
