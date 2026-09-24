import { createHash } from "node:crypto";

/** Small LRU with TTL. Keys must already include the tenant. */
export class LruCache<V> {
  private map = new Map<string, { value: V; expires: number }>();
  constructor(private readonly max: number, private readonly ttlMs: number) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    if (hit.expires < Date.now()) return undefined;
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V) {
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }

  get size() {
    return this.map.size;
  }
}

export function sha256(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Per-key token bucket. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly capacity: number, private readonly perMinute: number) {}

  /** Takes `cost` tokens if available. Returns ms to wait otherwise. */
  take(key: string, cost = 1): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 60_000) * this.perMinute);
    b.at = now;
    this.buckets.set(key, b);
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { ok: true };
    }
    return { ok: false, retryAfterMs: Math.ceil(((cost - b.tokens) / this.perMinute) * 60_000) };
  }
}

export class CapacityError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("Classifier capacity exhausted");
  }
}

/**
 * Global guard in front of the provider: bounded concurrency plus a
 * requests-per-minute budget below the provider's documented limit.
 */
export class Gate {
  private active = 0;
  private waiting: Array<() => void> = [];
  private stamps: number[] = [];

  constructor(private readonly maxConcurrent: number, private readonly perMinute: number) {}

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const now = Date.now();
    this.stamps = this.stamps.filter((t) => now - t < 60_000);
    if (this.stamps.length >= this.perMinute) throw new CapacityError(60_000 - (now - this.stamps[0]!));
    this.stamps.push(now);
    if (this.active < this.maxConcurrent) this.active++;
    else {
      // The finishing task hands its slot straight to us.
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          this.waiting = this.waiting.filter((w) => w !== go);
          reject(signal!.reason);
        };
        this.waiting.push(go);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
