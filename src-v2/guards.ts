type ReplayState = "processing" | "settled";

interface ReplayEntry {
  state: ReplayState;
  expiresAt: number;
}

interface RateWindow {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
}

export class ReplayProtector {
  private readonly entries = new Map<string, ReplayEntry>();
  private readonly processingTtlMs: number;
  private readonly settledTtlMs: number;

  public constructor(processingTtlMs = 120_000, settledTtlMs = 86_400_000) {
    this.processingTtlMs = processingTtlMs;
    this.settledTtlMs = settledTtlMs;
  }

  public reserve(key: string): { ok: true } | { ok: false; state: ReplayState } {
    this.prune();
    const existing = this.entries.get(key);
    if (existing) {
      return { ok: false, state: existing.state };
    }

    this.entries.set(key, {
      state: "processing",
      expiresAt: Date.now() + this.processingTtlMs
    });
    return { ok: true };
  }

  public markSettled(key: string): void {
    this.prune();
    this.entries.set(key, {
      state: "settled",
      expiresAt: Date.now() + this.settledTtlMs
    });
  }

  public release(key: string): void {
    this.entries.delete(key);
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries.entries()) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, RateWindow>();

  public consume(scope: string, limit: number, windowMs: number): RateLimitResult {
    const now = Date.now();
    const current = this.windows.get(scope);

    if (!current || current.resetAt <= now) {
      this.windows.set(scope, {
        count: 1,
        resetAt: now + windowMs
      });
      return {
        allowed: true,
        retryAfterSeconds: Math.ceil(windowMs / 1000),
        remaining: Math.max(limit - 1, 0)
      };
    }

    if (current.count >= limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(Math.ceil((current.resetAt - now) / 1000), 1),
        remaining: 0
      };
    }

    current.count += 1;
    return {
      allowed: true,
      retryAfterSeconds: Math.max(Math.ceil((current.resetAt - now) / 1000), 1),
      remaining: Math.max(limit - current.count, 0)
    };
  }
}
