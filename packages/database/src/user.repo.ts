import crypto from "node:crypto";
import type { User, Session, StoragePeer, TelegramStatus } from "@teledrive/shared";
import { Database, nowIso } from "./db.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface UserRow {
  id: string;
  telegram_user_id: string;
  display_name: string;
  username: string | null;
  telegram_status: TelegramStatus;
  created_at: string;
  updated_at: string;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    telegramUserId: row.telegram_user_id,
    displayName: row.display_name,
    username: row.username,
    telegramStatus: row.telegram_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const USER_COLUMNS = "id, telegram_user_id, display_name, username, telegram_status, created_at, updated_at";

function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export interface TelegramIdentity {
  telegramUserId: string;
  displayName: string;
  username: string | null;
  /** Encrypted MTProto session string (never the plaintext). */
  sessionEnc: string;
}

export class UserRepository {
  constructor(private db: Database) {}

  /** Creates the user on first QR login, or reconnects an existing one. */
  async upsertFromTelegram(identity: TelegramIdentity): Promise<User> {
    const now = nowIso();
    return this.db.transaction(() => {
      const existing = this.db.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE telegram_user_id = ?`, identity.telegramUserId);
      if (existing) {
        this.db.run(
          `UPDATE users SET display_name = ?, username = ?, session_enc = ?, telegram_status = 'active', updated_at = ? WHERE id = ?`,
          identity.displayName, identity.username, identity.sessionEnc, now, existing.id
        );
      } else {
        this.db.run(
          `INSERT INTO users (id, telegram_user_id, display_name, username, session_enc, telegram_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
          `usr_${crypto.randomUUID()}`, identity.telegramUserId, identity.displayName, identity.username, identity.sessionEnc, now, now
        );
      }
      return toUser(this.db.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE telegram_user_id = ?`, identity.telegramUserId)!);
    });
  }

  async getUserById(userId: string): Promise<User | null> {
    const row = this.db.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, userId);
    return row ? toUser(row) : null;
  }

  /** Server-only: the encrypted MTProto session. Never return this through the API. */
  async getSessionEnc(userId: string): Promise<string | null> {
    const row = this.db.get<{ session_enc: string | null; telegram_status: TelegramStatus }>(
      "SELECT session_enc, telegram_status FROM users WHERE id = ?", userId
    );
    if (!row || row.telegram_status !== "active") return null;
    return row.session_enc;
  }

  async getStoragePeer(userId: string): Promise<StoragePeer | null> {
    const row = this.db.get<{ storage_channel_id: string | null; storage_access_hash: string | null }>(
      "SELECT storage_channel_id, storage_access_hash FROM users WHERE id = ?", userId
    );
    if (!row?.storage_channel_id || !row.storage_access_hash) return null;
    return { channelId: row.storage_channel_id, accessHash: row.storage_access_hash };
  }

  async setStoragePeer(userId: string, peer: StoragePeer): Promise<void> {
    this.db.run(
      "UPDATE users SET storage_channel_id = ?, storage_access_hash = ?, updated_at = ? WHERE id = ?",
      peer.channelId, peer.accessHash, nowIso(), userId
    );
  }

  /**
   * Telegram session is gone (user logged out, or revoked it from Telegram → Devices).
   * Wipes the stored credential and every app session so the user must log in again.
   */
  async markTelegramRevoked(userId: string): Promise<void> {
    this.db.transaction(() => {
      this.db.run("UPDATE users SET session_enc = NULL, telegram_status = 'revoked', updated_at = ? WHERE id = ?", nowIso(), userId);
      this.db.run("DELETE FROM sessions WHERE user_id = ?", userId);
    });
  }

  async createSession(userId: string): Promise<{ session: Session; token: string }> {
    const rawToken = crypto.randomBytes(32).toString("base64url");
    const now = new Date();
    const session: Session = {
      id: `ses_${crypto.randomUUID()}`,
      userId,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
      createdAt: now.toISOString()
    };
    this.db.run(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
      session.id, session.userId, session.tokenHash, session.expiresAt, session.createdAt
    );
    return { session, token: rawToken };
  }

  async validateSession(rawToken: string): Promise<User | null> {
    if (!rawToken || rawToken.length > 128) return null;
    const row = this.db.get<UserRow & { expires_at: string }>(
      `SELECT u.id, u.telegram_user_id, u.display_name, u.username, u.telegram_status, u.created_at, u.updated_at, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
      hashToken(rawToken)
    );
    if (!row || row.telegram_status !== "active") return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      this.db.run("DELETE FROM sessions WHERE token_hash = ?", hashToken(rawToken));
      return null;
    }
    return toUser(row);
  }

  async revokeSession(rawToken: string): Promise<void> {
    this.db.run("DELETE FROM sessions WHERE token_hash = ?", hashToken(rawToken));
  }

  async countActiveSessions(userId: string): Promise<number> {
    const row = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?", userId, nowIso());
    return row?.n ?? 0;
  }

  async purgeExpiredSessions(): Promise<number> {
    return this.db.run("DELETE FROM sessions WHERE expires_at <= ?", nowIso()).changes;
  }
}
