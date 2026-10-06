import type { TelegramClient } from "telegram";

export interface DownloadPoolOptions {
  /** Max parallel pooled (download-only) connections; the main client is not counted. */
  maxConnections: number;
  /** Opens one more connected client on the same Telegram session. Omit to disable pooling. */
  factory?: () => Promise<TelegramClient>;
  /** Extra connections are closed after this long without any download activity. */
  idleMs?: number;
  /** After a failed attempt to open connections, wait this long before trying again. */
  retryAfterFailureMs?: number;
}

export interface ConnectionLease {
  client: TelegramClient;
  /** True for pooled connections (the main client is never evicted/closed by the pool). */
  isExtra: boolean;
  release(): void;
}

/**
 * Parallel download connections for ONE user's Telegram session.
 *
 * Telegram limits download throughput per connection, so a single connection tops out at a fraction
 * of the user's bandwidth. Official clients open several; so do we. All connections share the same
 * session (auth key) and live in the same process, so the single-owner rule (ADR-007) still holds.
 *
 * The main client is reserved for everything else (uploads, deletes, metadata). Sharing it with big
 * downloads starves uploads (measured: upload 3 MB/s -> 0.4 MB/s), so large downloads run only on the
 * pooled connections; the main one serves just small, latency-sensitive reads (and is the fallback
 * when no pooled connection could be opened).
 */
export class DownloadConnectionPool {
  private extras: TelegramClient[] = [];
  private readonly busy = new Map<TelegramClient, number>();
  private growing: Promise<void> | null = null;
  private retryGrowAt = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private cursor = 0;
  private closed = false;

  constructor(private readonly main: TelegramClient, private readonly options: DownloadPoolOptions) {}

  /** Pooled connections currently open. */
  get size(): number {
    return this.extras.length;
  }

  /** Grows the pool towards `want` pooled connections (best effort: failures leave the pool as it is). */
  async ensure(want: number): Promise<void> {
    const target = Math.min(Math.max(Math.floor(want), 1), this.options.maxConnections);
    if (!this.options.factory || this.closed || this.size >= target || Date.now() < this.retryGrowAt) return;
    this.growing ??= this.grow(target).finally(() => {
      this.growing = null;
    });
    await this.growing;
  }

  private async grow(target: number): Promise<void> {
    const missing = target - this.size;
    const results = await Promise.allSettled(Array.from({ length: missing }, () => this.options.factory!()));
    let failed = false;
    for (const result of results) {
      if (result.status === "rejected") {
        failed = true;
      } else if (this.closed) {
        await result.value.disconnect().catch(() => undefined);
      } else {
        this.extras.push(result.value);
      }
    }
    if (failed) this.retryGrowAt = Date.now() + (this.options.retryAfterFailureMs ?? 30_000);
  }

  /**
   * Leases the least busy connection (ties rotate), so one slow connection doesn't hold up the stream.
   * With `bulk` the main client is avoided as long as any pooled connection exists.
   */
  lease(bulk = false): ConnectionLease {
    const all = bulk && this.extras.length > 0 ? [...this.extras] : [this.main];
    let best = all[this.cursor % all.length];
    for (let i = 0; i < all.length; i++) {
      const candidate = all[(this.cursor + i) % all.length];
      if ((this.busy.get(candidate) ?? 0) < (this.busy.get(best) ?? 0)) best = candidate;
    }
    this.cursor++;
    this.busy.set(best, (this.busy.get(best) ?? 0) + 1);
    this.clearIdleTimer();

    let released = false;
    return {
      client: best,
      isExtra: best !== this.main,
      release: () => {
        if (released) return;
        released = true;
        this.busy.set(best, Math.max(0, (this.busy.get(best) ?? 1) - 1));
        this.armIdleTimer();
      }
    };
  }

  /** Drops a pooled connection that turned out to be dead. */
  evict(client: TelegramClient): void {
    if (client === this.main) return;
    this.extras = this.extras.filter(c => c !== client);
    this.busy.delete(client);
    void client.disconnect().catch(() => undefined);
  }

  private totalBusy(): number {
    let total = 0;
    for (const n of this.busy.values()) total += n;
    return total;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private armIdleTimer(): void {
    if (this.closed || this.extras.length === 0 || this.totalBusy() > 0) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.totalBusy() === 0) void this.dropExtras();
    }, this.options.idleMs ?? 60_000);
    this.idleTimer.unref();
  }

  private async dropExtras(): Promise<void> {
    const extras = this.extras;
    this.extras = [];
    this.busy.clear();
    await Promise.all(extras.map(c => c.disconnect().catch(() => undefined)));
  }

  /** Closes every pooled connection. The main client is left to its owner. */
  async close(): Promise<void> {
    this.closed = true;
    this.clearIdleTimer();
    if (this.growing) await this.growing.catch(() => undefined);
    await this.dropExtras();
  }
}
