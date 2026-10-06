import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { LogLevel } from "telegram/extensions/Logger.js";

export interface TelegramAppCredentials {
  apiId: number;
  apiHash: string;
}

/** Where connection diagnostics go. Defaults to the console; tests inject their own. */
export interface ClientLogSink {
  warn(message: string): void;
  error(error: unknown): void;
}

const KEEPALIVE_WARN_INTERVAL_MS = 60_000;

/** The keep-alive ping in gramjs' update loop timing out (it throws a bare `Error("TIMEOUT")`). */
function isKeepAliveTimeout(err: unknown): boolean {
  return err instanceof Error && err.message === "TIMEOUT" && /[\\/]updates\.js/.test(err.stack ?? "");
}

/**
 * gramjs prints a full stack trace each time the update loop's keep-alive ping times out, then
 * reconnects. That happens routinely while a transfer saturates the connection, so a stack trace per
 * occurrence only buries real problems. Replace it with one short, rate-limited warning; every other
 * error keeps gramjs' normal reporting.
 *
 * gramjs calls the error handler and, right after, prints the error if the ERROR level is enabled
 * (and prints it itself when no handler is set). We use the handler to classify the error and veto
 * that single print for keep-alive timeouts.
 */
export function quietKeepAliveTimeouts(client: TelegramClient, sink: ClientLogSink = { warn: m => console.warn(m), error: e => console.error(e) }): void {
  const log = client._log;
  const canSend = log.canSend.bind(log);
  let vetoNextErrorPrint = false;
  let lastWarnAt = 0;
  let suppressed = 0;

  client.onError = async (err: Error) => {
    if (isKeepAliveTimeout(err)) {
      vetoNextErrorPrint = true;
      suppressed++;
      const now = Date.now();
      if (now - lastWarnAt >= KEEPALIVE_WARN_INTERVAL_MS) {
        sink.warn(`[Telegram] keep-alive ping timed out ${suppressed}x (connection busy); reconnecting automatically`);
        lastWarnAt = now;
        suppressed = 0;
      }
      return;
    }
    vetoNextErrorPrint = false;
    // Having a handler also stops gramjs from printing errors reported outside the update loop.
    if (!/[\\/]updates\.js/.test(err.stack ?? "")) sink.error(err);
  };

  log.canSend = (level: LogLevel): boolean => {
    if (vetoNextErrorPrint && level === LogLevel.ERROR) {
      vetoNextErrorPrint = false;
      return false;
    }
    return canSend(level);
  };
}

/**
 * Creates a gramjs client for ONE user's session. Only the telegram-connector package
 * may call this (ADR-007): a session must never be used by two processes at once.
 */
export function createTelegramClient(credentials: TelegramAppCredentials, sessionString = ""): TelegramClient {
  const client = new TelegramClient(new StringSession(sessionString), credentials.apiId, credentials.apiHash, {
    connectionRetries: 5,
    autoReconnect: true,
    // Short waits are slept automatically; longer ones surface as FloodWaitError.
    floodSleepThreshold: 10,
    deviceModel: "TeleDrive",
    appVersion: "1.3.0"
  });
  client.setLogLevel(LogLevel.ERROR);
  quietKeepAliveTimeouts(client);
  return client;
}

export function exportSession(client: TelegramClient): string {
  return (client.session as StringSession).save();
}
