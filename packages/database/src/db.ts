import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/** Repository root, resolved from this file — never from process.cwd(). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function resolveDataPath(envValue: string | undefined, fallback: string): string {
  return path.resolve(REPO_ROOT, envValue && envValue.trim() !== "" ? envValue : fallback);
}

export function defaultDatabasePath(): string {
  return resolveDataPath(process.env.DATABASE_PATH, "data/teledrive.sqlite");
}

/**
 * Ordered schema migrations. Append only — never edit a migration that has shipped.
 * PRAGMA user_version tracks how many have been applied.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id                  TEXT PRIMARY KEY,
    telegram_user_id    TEXT NOT NULL UNIQUE,
    display_name        TEXT NOT NULL,
    username            TEXT,
    session_enc         TEXT,
    telegram_status     TEXT NOT NULL DEFAULT 'active' CHECK (telegram_status IN ('active', 'revoked')),
    storage_channel_id  TEXT,
    storage_access_hash TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE folders (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id      TEXT REFERENCES folders(id) ON DELETE SET NULL,
    name           TEXT NOT NULL,
    deleted_at     TEXT,
    trash_root_id  TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE INDEX folders_listing ON folders(user_id, parent_id, deleted_at);
  CREATE INDEX folders_trash ON folders(user_id, trash_root_id);

  CREATE TABLE files (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    folder_id      TEXT REFERENCES folders(id) ON DELETE SET NULL,
    name           TEXT NOT NULL,
    mime_type      TEXT NOT NULL,
    size_bytes     INTEGER NOT NULL,
    checksum       TEXT,
    status         TEXT NOT NULL CHECK (status IN ('pending', 'uploading', 'ready', 'failed', 'cancelled')),
    deleted_at     TEXT,
    trash_root_id  TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE INDEX files_listing ON files(user_id, folder_id, deleted_at);
  CREATE INDEX files_name ON files(user_id, name);
  CREATE INDEX files_trash ON files(user_id, trash_root_id);

  CREATE TABLE telegram_objects (
    file_id         TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    peer_id         TEXT NOT NULL,
    message_id      INTEGER NOT NULL,
    document_id     TEXT NOT NULL,
    access_hash     TEXT NOT NULL,
    file_reference  TEXT NOT NULL,
    dc_id           INTEGER NOT NULL,
    created_at      TEXT NOT NULL
  );

  CREATE TABLE jobs (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_id         TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    status          TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
    progress_bytes  INTEGER NOT NULL DEFAULT 0,
    total_bytes     INTEGER NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    error_code      TEXT,
    temp_path       TEXT,
    run_after       TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE INDEX jobs_status ON jobs(status, run_after);
  CREATE INDEX jobs_user ON jobs(user_id, status);

  CREATE TABLE favorites (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_id     TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (user_id, file_id)
  );
  `
];

export type Row = Record<string, SQLInputValue>;

export class Database {
  public readonly filePath: string;
  private readonly sql: DatabaseSync;
  private txDepth = 0;

  /** Pass ":memory:" for an ephemeral database (tests). */
  constructor(filePath: string = defaultDatabasePath()) {
    this.filePath = filePath;
    if (filePath !== ":memory:") {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    this.sql = new DatabaseSync(filePath);
    this.sql.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
    this.migrate();
  }

  private migrate(): void {
    const { user_version: current } = this.sql.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let i = current; i < MIGRATIONS.length; i++) {
      this.transaction(() => {
        this.sql.exec(MIGRATIONS[i]);
        this.sql.exec(`PRAGMA user_version = ${i + 1}`);
      });
    }
  }

  get<T>(query: string, ...params: SQLInputValue[]): T | undefined {
    return this.sql.prepare(query).get(...params) as T | undefined;
  }

  all<T>(query: string, ...params: SQLInputValue[]): T[] {
    return this.sql.prepare(query).all(...params) as T[];
  }

  run(query: string, ...params: SQLInputValue[]): { changes: number } {
    const result = this.sql.prepare(query).run(...params);
    return { changes: Number(result.changes) };
  }

  /** Runs fn atomically. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth++;
      try {
        return fn();
      } finally {
        this.txDepth--;
      }
    }
    this.sql.exec("BEGIN IMMEDIATE");
    this.txDepth = 1;
    try {
      const result = fn();
      this.sql.exec("COMMIT");
      return result;
    } catch (err) {
      this.sql.exec("ROLLBACK");
      throw err;
    } finally {
      this.txDepth = 0;
    }
  }

  close(): void {
    this.sql.close();
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Escapes LIKE wildcards so user input is matched literally (use with ESCAPE '\\'). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, ch => `\\${ch}`);
}
