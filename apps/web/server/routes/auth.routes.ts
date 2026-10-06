import { Router, type Response, type CookieOptions } from "express";
import QRCode from "qrcode";
import { AppError, ErrorCode, QrPasswordSchema } from "@teledrive/shared";
import type { UserRepository } from "@teledrive/database";
import type { QrLoginProvider, TelegramConnectorService } from "@teledrive/telegram-connector";
import { asyncHandler, sendSuccess } from "../http.ts";
import { SESSION_COOKIE, requireAuth, requireUser, rateLimit, clientIp, type AuthedRequest } from "../middleware.ts";

const QR_COOKIE = "td_qr";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface AuthRouteDeps {
  users: UserRepository;
  qrLogin: QrLoginProvider;
  connector: TelegramConnectorService;
  secureCookies: boolean;
}

export function authRoutes(deps: AuthRouteDeps): Router {
  const router = Router();
  const baseCookie: CookieOptions = { httpOnly: true, secure: deps.secureCookies, sameSite: "strict" };
  const qrCookie: CookieOptions = { ...baseCookie, path: "/api/auth/qr", maxAge: 6 * 60 * 1000 };

  const readQrCookie = (value: unknown): { attemptId: string; secret: string } => {
    if (typeof value !== "string") throw new AppError(ErrorCode.NOT_FOUND, "No login attempt in progress", 404);
    const [attemptId, secret] = value.split(".");
    if (!attemptId || !secret) throw new AppError(ErrorCode.NOT_FOUND, "No login attempt in progress", 404);
    return { attemptId, secret };
  };

  const startLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, key: req => `qr:${clientIp(req)}`, message: "Too many login attempts. Wait a few minutes." });
  const passwordLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, key: req => `pw:${clientIp(req)}`, message: "Too many password attempts. Wait a few minutes." });
  const pollLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, key: req => `poll:${clientIp(req)}` });

  // Start a QR login attempt. The attempt is bound to this browser via an httpOnly cookie.
  router.post("/qr", startLimiter, asyncHandler(async (req, res) => {
    const previous = req.cookies?.[QR_COOKIE];
    if (typeof previous === "string") {
      const [id, secret] = previous.split(".");
      if (id && secret) await deps.qrLogin.cancel(id, secret).catch(() => undefined);
    }
    const { attemptId, browserSecret } = deps.qrLogin.start();
    res.cookie(QR_COOKIE, `${attemptId}.${browserSecret}`, qrCookie);
    sendSuccess(res, { started: true }, {}, 201);
  }));

  // Poll the attempt. On success this issues the TeleDrive session cookie.
  router.get("/qr", pollLimiter, asyncHandler(async (req, res) => {
    const { attemptId, secret } = readQrCookie(req.cookies?.[QR_COOKIE]);
    const { state, user } = await deps.qrLogin.status(attemptId, secret);

    if (state.status === "success" && user) {
      const { token } = await deps.users.createSession(user.id);
      res.clearCookie(QR_COOKIE, { path: "/api/auth/qr" });
      res.cookie(SESSION_COOKIE, token, { ...baseCookie, path: "/", maxAge: SESSION_MAX_AGE_MS });
      sendSuccess(res, { state, user });
      return;
    }
    if (state.status === "expired" || state.status === "failed") {
      res.clearCookie(QR_COOKIE, { path: "/api/auth/qr" });
    }
    const qrSvg = state.status === "waiting" && state.qrUrl
      ? await QRCode.toString(state.qrUrl, { type: "svg", margin: 1, errorCorrectionLevel: "M" })
      : null;
    res.setHeader("Cache-Control", "no-store");
    sendSuccess(res, { state, qrSvg, user: null });
  }));

  router.post("/qr/password", passwordLimiter, asyncHandler(async (req, res) => {
    const { attemptId, secret } = readQrCookie(req.cookies?.[QR_COOKIE]);
    const { password } = QrPasswordSchema.parse(req.body);
    deps.qrLogin.submitPassword(attemptId, secret, password);
    sendSuccess(res, { submitted: true }, {}, 202);
  }));

  router.delete("/qr", asyncHandler(async (req, res) => {
    const value = req.cookies?.[QR_COOKIE];
    if (typeof value === "string") {
      const [id, secret] = value.split(".");
      if (id && secret) await deps.qrLogin.cancel(id, secret).catch(() => undefined);
    }
    res.clearCookie(QR_COOKIE, { path: "/api/auth/qr" });
    sendSuccess(res, { cancelled: true });
  }));

  // Logout. When the last TeleDrive session of the user ends, the Telegram session is
  // terminated too, so no live credential for an absent user is kept on the server.
  router.post("/logout", requireAuth(deps.users), asyncHandler(async (req, res: Response) => {
    const user = requireUser(req);
    await deps.users.revokeSession((req as AuthedRequest).sessionToken);
    if ((await deps.users.countActiveSessions(user.id)) === 0) {
      await deps.connector.logoutTelegram(user.id).catch(err => {
        console.warn("[Auth] Telegram logout failed:", err instanceof Error ? err.message : err);
      });
    }
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    sendSuccess(res, { loggedOut: true });
  }));

  return router;
}
