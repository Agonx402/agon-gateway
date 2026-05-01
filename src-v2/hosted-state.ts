import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import type { GatewayConfig } from "./types";

const PROCESSING_TTL_SECONDS = 120;
const SETTLED_TTL_SECONDS = 86_400;

export interface RateLimitOutcome {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface AgonChannelLedger {
  latestAcceptedCommitted: string | null;
  oldestUnsettledAcceptedAt: string | null;
  inFlightRequestId: string | null;
  inFlightCommittedAmount: string | null;
  latestEnvelope: string | null;
}

export interface AgonChannelReservation {
  ok: boolean;
  state?: string;
  latestAcceptedCommitted?: string;
  reason?: string;
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

  public async getAgonChannelLedger(channelKey: string): Promise<AgonChannelLedger> {
    const ledger = await this.redis.hgetall<Record<string, string>>(this.agonChannelLedgerKey(channelKey));
    return {
      latestAcceptedCommitted: ledger?.latestAcceptedCommitted ?? null,
      oldestUnsettledAcceptedAt: ledger?.oldestUnsettledAcceptedAt ?? null,
      inFlightRequestId: ledger?.inFlightRequestId ?? null,
      inFlightCommittedAmount: ledger?.inFlightCommittedAmount ?? null,
      latestEnvelope: ledger?.latestEnvelope ?? null,
    };
  }

  public async reserveAgonChannelCommitment(params: {
    channelKey: string;
    requestId: string;
    requestHash: string;
    baselineCommittedAmount: string;
    expectedPreviousCommittedAmount: string;
    newCommittedAmount: string;
    ttlSeconds?: number;
  }): Promise<AgonChannelReservation> {
    const script = `
local ledgerKey = KEYS[1]
local requestKey = KEYS[2]
local existingRequest = redis.call("GET", requestKey)
if existingRequest then
  return cjson.encode({ ok = false, state = existingRequest, reason = "request_replay" })
end
local inFlight = redis.call("HGET", ledgerKey, "inFlightRequestId")
if inFlight then
  return cjson.encode({ ok = false, state = inFlight, reason = "channel_busy" })
end
local latest = redis.call("HGET", ledgerKey, "latestAcceptedCommitted")
if not latest then
  latest = ARGV[1]
end
if latest ~= ARGV[2] then
  return cjson.encode({ ok = false, latestAcceptedCommitted = latest, reason = "latest_mismatch" })
end
local reservation = cjson.encode({ state = "processing", channelKey = ARGV[6], committedAmount = ARGV[3] })
redis.call("SET", requestKey, reservation, "EX", ARGV[4])
redis.call("HSET", ledgerKey, "inFlightRequestId", ARGV[5], "inFlightCommittedAmount", ARGV[3], "inFlightStartedAt", ARGV[7])
redis.call("EXPIRE", ledgerKey, 2592000)
return cjson.encode({ ok = true, latestAcceptedCommitted = latest })
`;
    const raw = await (this.redis as any).eval(
      script,
      [this.agonChannelLedgerKey(params.channelKey), this.agonChannelRequestKey(params.requestHash)],
      [
        params.baselineCommittedAmount,
        params.expectedPreviousCommittedAmount,
        params.newCommittedAmount,
        String(params.ttlSeconds ?? PROCESSING_TTL_SECONDS),
        params.requestId,
        params.channelKey,
        String(Date.now()),
      ],
    );
    return JSON.parse(String(raw)) as AgonChannelReservation;
  }

  public async promoteAgonChannelCommitment(params: {
    channelKey: string;
    requestId: string;
    requestHash: string;
    committedAmount: string;
    envelope: string;
  }): Promise<void> {
    const now = String(Date.now());
    const script = `
local ledgerKey = KEYS[1]
local requestKey = KEYS[2]
local inFlight = redis.call("HGET", ledgerKey, "inFlightRequestId")
if inFlight == ARGV[1] then
  redis.call("HSET", ledgerKey, "latestAcceptedCommitted", ARGV[2])
  redis.call("HSET", ledgerKey, "latestEnvelope", ARGV[6], "latestAcceptedAt", ARGV[3])
  if not redis.call("HGET", ledgerKey, "oldestUnsettledAcceptedAt") then
    redis.call("HSET", ledgerKey, "oldestUnsettledAcceptedAt", ARGV[3])
  end
  redis.call("HDEL", ledgerKey, "inFlightRequestId", "inFlightCommittedAmount", "inFlightStartedAt")
end
redis.call("SET", requestKey, cjson.encode({ state = "accepted", channelKey = ARGV[4], committedAmount = ARGV[2] }), "EX", ARGV[5])
redis.call("EXPIRE", ledgerKey, 2592000)
return "OK"
`;
    await (this.redis as any).eval(
      script,
      [this.agonChannelLedgerKey(params.channelKey), this.agonChannelRequestKey(params.requestHash)],
      [params.requestId, params.committedAmount, now, params.channelKey, String(SETTLED_TTL_SECONDS), params.envelope],
    );
  }

  public async releaseAgonChannelCommitment(params: {
    channelKey: string;
    requestId: string;
    requestHash: string;
  }): Promise<void> {
    const script = `
local ledgerKey = KEYS[1]
local requestKey = KEYS[2]
local inFlight = redis.call("HGET", ledgerKey, "inFlightRequestId")
if inFlight == ARGV[1] then
  redis.call("HDEL", ledgerKey, "inFlightRequestId", "inFlightCommittedAmount", "inFlightStartedAt")
end
redis.call("DEL", requestKey)
return "OK"
`;
    await (this.redis as any).eval(
      script,
      [this.agonChannelLedgerKey(params.channelKey), this.agonChannelRequestKey(params.requestHash)],
      [params.requestId],
    );
  }

  public async markAgonChannelSettled(params: {
    channelKey: string;
    settledCumulative: string;
  }): Promise<void> {
    await this.redis.hset(this.agonChannelLedgerKey(params.channelKey), {
      latestAcceptedCommitted: params.settledCumulative,
      oldestUnsettledAcceptedAt: "",
    });
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

  // Nonce tracking is intentionally NOT implemented. The optional
  // `hasUsedNonce` / `recordNonce` methods on the x402 SIWxStorage
  // interface, when both implemented, force every SIWX header to be
  // single-use. Agon's Tokens routes are read-only and rely on the
  // signed `expirationTime` (default 5 min) for replay protection,
  // which is the same guarantee the Coinbase x402 reference server
  // ships with by default. Leaving these methods undefined lets the
  // SIWX hook treat valid signed headers as TTL-bounded bearers and
  // gives clients (CLI, MCP, browser) the playground-equivalent
  // latency the protocol was designed for.

  private replayKey(key: string): string {
    return `replay:${key}`;
  }

  private agonChannelLedgerKey(channelKey: string): string {
    return `agon-channel:ledger:${this.hashKey(channelKey)}`;
  }

  private agonChannelRequestKey(requestHash: string): string {
    return `agon-channel:request:${requestHash}`;
  }

  private hashKey(input: string): string {
    return createHash("sha256").update(input).digest("hex");
  }
}
