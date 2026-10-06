import crypto from "node:crypto";

const VERSION = "v1";

/**
 * AES-256-GCM encryption for MTProto session strings at rest.
 * A session string is full access to a user's Telegram account — it is only ever
 * stored encrypted and decrypted inside the connector.
 */
export class SessionCrypto {
  private readonly key: Buffer;

  constructor(rawKey: string | undefined) {
    const key = SessionCrypto.parseKey(rawKey);
    if (!key) {
      throw new Error(
        "TELEGRAM_SESSION_ENCRYPTION_KEY must be 32 bytes, given as 64 hex chars or base64. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
      );
    }
    this.key = key;
  }

  static parseKey(raw: string | undefined): Buffer | null {
    if (!raw) return null;
    const value = raw.trim();
    if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
    const decoded = Buffer.from(value, "base64");
    return decoded.length === 32 ? decoded : null;
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  decrypt(payload: string): string {
    const [version, iv, tag, ciphertext] = payload.split(".");
    if (version !== VERSION || !iv || !tag || ciphertext === undefined) throw new Error("Unsupported session payload");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  }
}
