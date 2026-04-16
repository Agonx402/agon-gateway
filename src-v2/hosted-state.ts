import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import type { GatewayConfig } from "./types";

const PROCESSING_TTL_SECONDS = 120;
const SETTLED_TTL_SECONDS = 86_400;
const SIWX_NONCE_TTL_SECONDS = 60 * 10;

export interface RateLimitOutcome {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class HostedGatewayState {
  private readonly redis: Redis;

  public constructor(config: GatewayConfig) {
    this.redis = new Redis({
      url: config.upstashRedisRestUrl,
      token: config.upstashRedisRestToken,
    });
  }

  public async reserveReplay(key: string): Promise<{ ok: true } | { ok: false; state: string }> {
    const reserved = await this.redis.set(this.replayKey(key), "processing", {
      nx: true,
      ex: PROCESSING_TTL_SECONDS,
    });

    if (reserved === "OK") {
      return { ok: true };
    }

    const existing = await this.redis.get<string>(this.replayKey(key));
    return {
      ok: false,
      state: existing ?? "unknown",
    };
  }

  public async markReplaySettled(key: string): Promise<void> {
    await this.redis.set(this.replayKey(key), "settled", {
      ex: SETTLED_TTL_SECONDS,
    });
  }

  public async releaseReplay(key: string): Promise<void> {
    await this.redis.del(this.replayKey(key));
  }

  public async consumeRateLimit(scope: string, limit: number, windowMs: number): Promise<RateLimitOutcome> {
    const now = Date.now();
    const windowStart = now - (now % windowMs);
    const resetAt = windowStart + windowMs;
    const key = `ratelimit:${scope}:${windowStart}`;

    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, Math.max(Math.ceil(windowMs / 1000), 1));
    }

    return {
      allowed: count <= limit,
      retryAfterSeconds: Math.max(Math.ceil((resetAt - now) / 1000), 1),
    };
  }

  public async incrementCounter(key: string): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const counterKey = `metrics:${today}:${key}`;
    const count = await this.redis.incr(counterKey);
    if (count === 1) {
      await this.redis.expire(counterKey, 60 * 60 * 24 * 30);
    }
  }

  public async hasPaid(_resource: string, _address: string): Promise<boolean> {
    return false;
  }

  public async recordPayment(_resource: string, _address: string): Promise<void> {
    // Tokens routes are auth-only and paid routes remain pay-per-call.
  }

  public async hasUsedNonce(nonce: string): Promise<boolean> {
    const used = await this.redis.get<string>(this.siwxNonceKey(nonce));
    return used === "used";
  }

  public async recordNonce(nonce: string): Promise<void> {
    await this.redis.set(this.siwxNonceKey(nonce), "used", {
      ex: SIWX_NONCE_TTL_SECONDS,
    });
  }

  private replayKey(key: string): string {
    return `replay:${key}`;
  }

  private siwxNonceKey(nonce: string): string {
    return `siwx:nonce:${this.hashKey(nonce)}`;
  }

  private hashKey(input: string): string {
    return createHash("sha256").update(input).digest("hex");
  }
}
