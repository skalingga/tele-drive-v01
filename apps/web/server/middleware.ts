import type { Request, Response, NextFunction, RequestHandler } from "express";
import { AppError, ErrorCode, type User } from "@teledrive/shared";
import type { UserRepository } from "@teledrive/database";
import { sendError } from "./http.ts";

export const SESSION_COOKIE = "td_session";

/** Authenticated request context. */
export interface AuthedRequest extends Request {
  user: User;
  sessionToken: string;
}

export function requireUser(req: Request): User {
  const user = (req as Partial<AuthedRequest>).user;
  if (!user) throw new AppError(ErrorCode.AUTH_REQUIRED, "Authentication required", 401);
  return user;
}

/** Cookie-only session auth (no bearer tokens: the token is never exposed to page scripts). */
export function requireAuth(users: UserRepository): RequestHandler {
  return (req, _res, next) => {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== "string" || token === "") {
      next(new AppError(ErrorCode.AUTH_REQUIRED, "Authentication required", 401));
      return;
    }
    users
      .validateSession(token)
      .then(user => {
        if (!user) throw new AppError(ErrorCode.AUTH_REQUIRED, "Session invalid or expired", 401);
        Object.assign(req, { user, sessionToken: token });
        next();
      })
      .catch(next);
  };
}

/** Baseline hardening headers for every response. */
export function securityHeaders(options: { production: boolean }): RequestHandler {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "frame-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'"
  ].join("; ");

  return (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    // The Vite dev server injects inline scripts, so the app CSP is only enforced in production.
    if (options.production && !req.path.startsWith("/api/")) res.setHeader("Content-Security-Policy", csp);
    next();
  };
}

/**
 * CSRF defence in depth (cookies are already SameSite=Strict): state-changing requests
 * that carry an Origin header must come from this host.
 */
export function sameOriginMutations(): RequestHandler {
  return (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin) {
      let host: string | null = null;
      try {
        host = new URL(origin).host;
      } catch {
        host = null;
      }
      if (host !== req.headers.host) {
        sendError(res, 403, ErrorCode.FORBIDDEN, "Cross-origin request rejected");
        return;
      }
    }
    next();
  };
}

/** Small fixed-window limiter (single process). */
export function rateLimit(options: { windowMs: number; max: number; key: (req: Request) => string; message?: string }): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, options.windowMs);
  sweep.unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = options.key(req);
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + options.windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > options.max) {
      res.setHeader("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      sendError(res, 429, ErrorCode.RATE_LIMITED, options.message ?? "Too many requests, slow down.");
      return;
    }
    next();
  };
}

export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

export function userKey(req: Request): string {
  return (req as Partial<AuthedRequest>).user?.id ?? clientIp(req);
}
