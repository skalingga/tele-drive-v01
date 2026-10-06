import { Api, type TelegramClient } from "telegram";
import { computeCheck } from "telegram/Password.js";
import { createTelegramClient, type TelegramAppCredentials } from "./client.js";

export type QrLoginPhase =
  | { phase: "starting" }
  | { phase: "waiting"; qrUrl: string; expiresAt: Date }
  | { phase: "password_required"; hint: string | null; passwordError: string | null }
  | { phase: "success" }
  | { phase: "expired" }
  | { phase: "failed"; message: string };

/** Minimal surface of gramjs internals we rely on (`_switchDC` is used by gramjs' own QR flow). */
interface DcSwitchable {
  _switchDC(dcId: number): Promise<unknown>;
}

const ATTEMPT_TTL_MS = 5 * 60 * 1000;
const MAX_PASSWORD_TRIES = 5;

function rpcMessage(err: unknown): string {
  const e = err as { errorMessage?: string; message?: string };
  return e?.errorMessage ?? e?.message ?? String(err);
}

/**
 * One QR login attempt (auth.exportLoginToken flow) on a fresh, unauthorized client.
 *
 * Lifecycle: start() → "waiting" (QR shown; token re-exported whenever it expires)
 * → user scans in Telegram → [optional "password_required" for 2FA] → "success".
 * On success, `client` is an authorized client for the user and ownership passes to the caller.
 */
export class QrLoginAttempt {
  public phase: QrLoginPhase = { phase: "starting" };
  public readonly client: TelegramClient;
  private readonly deadline = Date.now() + ATTEMPT_TTL_MS;
  private wakeUp: (() => void) | null = null;
  private passwordResolver: ((password: string) => void) | null = null;
  private cancelled = false;
  private passwordTries = 0;
  private readonly done: Promise<void>;

  constructor(private readonly credentials: TelegramAppCredentials) {
    this.client = createTelegramClient(credentials);
    this.done = this.run();
  }

  /** Resolves when the attempt reaches a terminal phase (success/expired/failed). */
  finished(): Promise<void> {
    return this.done;
  }

  submitPassword(password: string): boolean {
    if (this.phase.phase !== "password_required" || !this.passwordResolver) return false;
    const resolve = this.passwordResolver;
    this.passwordResolver = null;
    resolve(password);
    return true;
  }

  /** Aborts the attempt and disconnects the (unauthorized) client. */
  async cancel(): Promise<void> {
    this.cancelled = true;
    this.wakeUp?.();
    if (this.phase.phase !== "success") {
      await this.client.disconnect().catch(() => undefined);
    }
  }

  private sleepUntil(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.wakeUp = null;
        resolve();
      }, Math.max(0, ms));
      this.wakeUp = () => {
        clearTimeout(timer);
        this.wakeUp = null;
        resolve();
      };
    });
  }

  private async run(): Promise<void> {
    try {
      await this.client.connect();
      this.client.addEventHandler((update: unknown) => {
        if (update instanceof Api.UpdateLoginToken) this.wakeUp?.();
      });

      while (!this.cancelled) {
        if (Date.now() > this.deadline) {
          this.phase = { phase: "expired" };
          await this.client.disconnect().catch(() => undefined);
          return;
        }

        let result: Api.auth.TypeLoginToken;
        try {
          result = await this.client.invoke(
            new Api.auth.ExportLoginToken({ apiId: this.credentials.apiId, apiHash: this.credentials.apiHash, exceptIds: [] })
          );
          if (result instanceof Api.auth.LoginTokenMigrateTo) {
            await (this.client as unknown as DcSwitchable)._switchDC(result.dcId);
            result = await this.client.invoke(new Api.auth.ImportLoginToken({ token: result.token }));
          }
        } catch (err) {
          if (rpcMessage(err).includes("SESSION_PASSWORD_NEEDED")) {
            await this.passwordStep();
            return;
          }
          throw err;
        }

        if (result instanceof Api.auth.LoginTokenSuccess) {
          this.phase = { phase: "success" };
          return;
        }
        if (result instanceof Api.auth.LoginToken) {
          const expiresAt = new Date(result.expires * 1000);
          this.phase = {
            phase: "waiting",
            qrUrl: `tg://login?token=${Buffer.from(result.token).toString("base64url")}`,
            expiresAt
          };
          // Wait for the scan (UpdateLoginToken) or until the token expires, then re-check.
          await this.sleepUntil(Math.min(expiresAt.getTime(), this.deadline) - Date.now());
          continue;
        }
        throw new Error(`Unexpected login token result: ${(result as { className?: string }).className ?? "unknown"}`);
      }
    } catch (err) {
      if (!this.cancelled) {
        this.phase = { phase: "failed", message: rpcMessage(err) };
      }
      await this.client.disconnect().catch(() => undefined);
    }
  }

  /** 2FA: wait for the cloud password from the browser and verify it with SRP. */
  private async passwordStep(): Promise<void> {
    const srp = await this.client.invoke(new Api.account.GetPassword());
    let passwordError: string | null = null;

    while (!this.cancelled) {
      this.phase = { phase: "password_required", hint: srp.hint ?? null, passwordError };
      const password = await new Promise<string | null>(resolve => {
        this.passwordResolver = resolve;
        const timer = setTimeout(() => resolve(null), Math.max(0, this.deadline - Date.now()));
        this.wakeUp = () => {
          clearTimeout(timer);
          resolve(null);
        };
      });
      if (password === null) {
        if (!this.cancelled) this.phase = { phase: "expired" };
        await this.client.disconnect().catch(() => undefined);
        return;
      }

      try {
        // A fresh SRP request is required for each attempt.
        const current = this.passwordTries === 0 ? srp : await this.client.invoke(new Api.account.GetPassword());
        this.passwordTries++;
        await this.client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(current, password) }));
        this.phase = { phase: "success" };
        return;
      } catch (err) {
        const message = rpcMessage(err);
        if (message.includes("PASSWORD_HASH_INVALID") && this.passwordTries < MAX_PASSWORD_TRIES) {
          passwordError = "Password 2FA salah. Coba lagi.";
          continue;
        }
        throw err;
      }
    }
  }
}
