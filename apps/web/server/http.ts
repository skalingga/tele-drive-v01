import type { Request, Response, NextFunction, RequestHandler } from "express";
import { ZodError } from "zod";
import { MulterError } from "multer";
import { AppError, ErrorCode } from "@teledrive/shared";

export function sendSuccess(res: Response, data: unknown, meta: Record<string, unknown> = {}, statusCode = 200): void {
  res.status(statusCode).json({ data, error: null, meta });
}

export function sendError(res: Response, statusCode: number, code: ErrorCode, message: string, details: unknown = null): void {
  res.status(statusCode).json({ data: null, error: { code, message, details }, meta: {} });
}

/** Express 4 does not catch rejected promises — route every async handler through this. */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** Central error → envelope mapping. Internal details are logged, never returned. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof ZodError || (err instanceof Error && err.name === "ZodError")) {
    const details = (err as ZodError).issues.map(i => ({ path: i.path.join("."), message: i.message }));
    sendError(res, 400, ErrorCode.VALIDATION_ERROR, "Invalid input", details);
    return;
  }
  if (err instanceof AppError) {
    if (err.code === ErrorCode.STORAGE_RATE_LIMITED && err.details && typeof err.details === "object" && "retryAfterSeconds" in err.details) {
      res.setHeader("Retry-After", String(err.details.retryAfterSeconds));
    }
    sendError(res, err.statusCode, err.code, err.message, err.details);
    return;
  }
  if (err instanceof MulterError) {
    const tooLarge = err.code === "LIMIT_FILE_SIZE";
    sendError(res, tooLarge ? 413 : 400, ErrorCode.VALIDATION_ERROR, tooLarge ? "File is larger than the upload limit" : "Invalid upload");
    return;
  }
  const httpErr = err as { type?: string; status?: number };
  if (httpErr?.type === "entity.parse.failed") {
    sendError(res, 400, ErrorCode.VALIDATION_ERROR, "Malformed JSON body");
    return;
  }
  if (httpErr?.type === "entity.too.large") {
    sendError(res, 413, ErrorCode.VALIDATION_ERROR, "Request body too large");
    return;
  }

  console.error(`[API] ${req.method} ${req.path} failed:`, err instanceof Error ? err.stack ?? err.message : err);
  sendError(res, 500, ErrorCode.INTERNAL_ERROR, "Internal server error");
}
