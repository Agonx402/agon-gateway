import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import type { GatewayConfig } from "./types";

const PROCESSING_TTL_SECONDS = 120;
const SETTLED_TTL_SECONDS = 86_400;

export interface RateLimitOutcome {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RyvoChannelLedger {
  latestAcceptedCommitted: string | null;
  oldestUnsettledAcceptedAt: string | null;
  inFlightRequestId: string | null;
  inFlightCommittedAmount: string | null;
  latestEnvelope: string | null;
  /** Most recent on-chain `settledCumulative` observed by the gateway. */
  lastSettledCumulative: string | null;
  /** Numeric payer participant id (string-encoded for Redis HASH). */
  payerParticipantId: string | null;
  /** Numeric payee participant id (string-encoded). */
  payeeParticipantId: string | null;
  /** Numeric token id (string-encoded). */
  tokenId: string | null;
  /** Base58 channel-bucket PDA. */
  channelBucket: string | null;
  /** Authorized signer pubkey (base58). */
  authorizedSigner: string | null;
  /** ISO timestamp of last on-chain settlement we observed. */
  lastSettledAt: string | null;
}

export interface RyvoChannelLedgerWithKey extends RyvoChannelLedger {
  channelKey: string;
}

export interface RyvoChannelReservation {
  ok: boolean;
  state?: string;
  latestAcceptedCommitted?: string;
  reason?: string;
}

export interface RyvoChannelLaneMetadata {
  payerParticipantId: number;
  payeeParticipantId: number;
  tokenId: number;
  channelBucket: string;
  authorizedSigner: string;
  /** On-chain `settledCumulative` snapshot at the time the lane was admitted. */
  settledCumulative: string;
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

  public async getRyvoChannelLedger(channelKey: string): Promise<RyvoChannelLedger> {
    const ledger = await this.redis.hgetall<Record<string, string>>(this.ryvoChannelLedgerKey(channelKey));
    return this.normalizeLedger(ledger);
  }

  /** Enumerate channels currently in the active set (have at least one unsettled commitment). */
  public async listActiveRyvoChannels(): Promise<string[]> {
    const members = await this.redis.smembers(this.ryvoChannelActiveSetKey());
    return members ?? [];
  }

  /** Read multiple channel ledgers at once for the settler's batch loop. */
  public async getRyvoChannelLedgersBatch(
    channelKeys: string[],
  ): Promise<RyvoChannelLedgerWithKey[]> {
    if (channelKeys.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const key of channelKeys) {
      pipeline.hgetall(this.ryvoChannelLedgerKey(key));
    }
    const results = (await pipeline.exec()) as Array<Record<string, string> | null>;
    return channelKeys.map((channelKey, idx) => ({
      channelKey,
      ...this.normalizeLedger(results[idx] ?? null),
    }));
  }

  /**
   * Persist the lane metadata we need at settlement time alongside the ledger
   * hash. Called once per channel — re-calling is harmless. The active set
   * membership is asserted on every accepted commitment via the Lua promote
   * script, so we don't add it here.
   */
  public async upsertRyvoChannelLaneMetadata(params: {
    channelKey: string;
    metadata: RyvoChannelLaneMetadata;
  }): Promise<void> {
    await this.redis.hset(this.ryvoChannelLedgerKey(params.channelKey), {
      payerParticipantId: String(params.metadata.payerParticipantId),
      payeeParticipantId: String(params.metadata.payeeParticipantId),
      tokenId: String(params.metadata.tokenId),
      channelBucket: params.metadata.channelBucket,
      authorizedSigner: params.metadata.authorizedSigner,
      lastSettledCumulative: params.metadata.settledCumulative,
    });
    await this.redis.expire(this.ryvoChannelLedgerKey(params.channelKey), 60 * 60 * 24 * 30);
  }

  private normalizeLedger(ledger: Record<string, string> | null | undefined): RyvoChannelLedger {
    return {
      latestAcceptedCommitted: ledger?.latestAcceptedCommitted ?? null,
      oldestUnsettledAcceptedAt: ledger?.oldestUnsettledAcceptedAt ?? null,
      inFlightRequestId: ledger?.inFlightRequestId ?? null,
      inFlightCommittedAmount: ledger?.inFlightCommittedAmount ?? null,
      latestEnvelope: ledger?.latestEnvelope ?? null,
      lastSettledCumulative: ledger?.lastSettledCumulative ?? null,
      payerParticipantId: ledger?.payerParticipantId ?? null,
      payeeParticipantId: ledger?.payeeParticipantId ?? null,
      tokenId: ledger?.tokenId ?? null,
      channelBucket: ledger?.channelBucket ?? null,
      authorizedSigner: ledger?.authorizedSigner ?? null,
      lastSettledAt: ledger?.lastSettledAt ?? null,
    };
  }

  public async reserveRyvoChannelCommitment(params: {
    channelKey: string;
    requestId: string;
    requestHash: string;
    baselineCommittedAmount: string;
    expectedPreviousCommittedAmount: string;
    newCommittedAmount: string;
    ttlSeconds?: number;
  }): Promise<RyvoChannelReservation> {
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
      [this.ryvoChannelLedgerKey(params.channelKey), this.ryvoChannelRequestKey(params.requestHash)],
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
    return JSON.parse(String(raw)) as RyvoChannelReservation;
  }

  public async promoteRyvoChannelCommitment(params: {
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
local activeSetKey = KEYS[3]
local inFlight = redis.call("HGET", ledgerKey, "inFlightRequestId")
if inFlight == ARGV[1] then
  redis.call("HSET", ledgerKey, "latestAcceptedCommitted", ARGV[2])
  redis.call("HSET", ledgerKey, "latestEnvelope", ARGV[6], "latestAcceptedAt", ARGV[3])
  if not redis.call("HGET", ledgerKey, "oldestUnsettledAcceptedAt") then
    redis.call("HSET", ledgerKey, "oldestUnsettledAcceptedAt", ARGV[3])
  end
  redis.call("HDEL", ledgerKey, "inFlightRequestId", "inFlightCommittedAmount", "inFlightStartedAt")
  redis.call("SADD", activeSetKey, ARGV[4])
end
redis.call("SET", requestKey, cjson.encode({ state = "accepted", channelKey = ARGV[4], committedAmount = ARGV[2] }), "EX", ARGV[5])
redis.call("EXPIRE", ledgerKey, 2592000)
return "OK"
`;
    await (this.redis as any).eval(
      script,
      [
        this.ryvoChannelLedgerKey(params.channelKey),
        this.ryvoChannelRequestKey(params.requestHash),
        this.ryvoChannelActiveSetKey(),
      ],
      [params.requestId, params.committedAmount, now, params.channelKey, String(SETTLED_TTL_SECONDS), params.envelope],
    );
  }

  public async releaseRyvoChannelCommitment(params: {
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
      [this.ryvoChannelLedgerKey(params.channelKey), this.ryvoChannelRequestKey(params.requestHash)],
      [params.requestId],
    );
  }

  /**
   * Atomically reconcile the ledger after a successful on-chain settlement.
   *
   * - Updates `lastSettledCumulative` and `lastSettledAt`.
   * - When the new on-chain `settledCumulative` >= the latest accepted
   *   off-chain commitment, the channel is fully reconciled: clears
   *   `oldestUnsettledAcceptedAt` and removes the channel from the active
   *   set. Otherwise the channel stays in the active set so the next cycle
   *   picks it up again.
   */
  public async markRyvoChannelSettled(params: {
    channelKey: string;
    settledCumulative: string;
  }): Promise<{ fullyReconciled: boolean }> {
    const now = String(Date.now());
    const script = `
local ledgerKey = KEYS[1]
local activeSetKey = KEYS[2]
local newSettled = ARGV[1]
local nowMs = ARGV[2]
local channelKey = ARGV[3]
local latest = redis.call("HGET", ledgerKey, "latestAcceptedCommitted")
redis.call("HSET", ledgerKey, "lastSettledCumulative", newSettled, "lastSettledAt", nowMs)
local fully = 0
local function toNum(v)
  if not v then return 0 end
  return tonumber(v) or 0
end
if latest == nil or toNum(newSettled) >= toNum(latest) then
  redis.call("HSET", ledgerKey, "oldestUnsettledAcceptedAt", "")
  redis.call("SREM", activeSetKey, channelKey)
  fully = 1
end
return fully
`;
    const raw = await (this.redis as any).eval(
      script,
      [this.ryvoChannelLedgerKey(params.channelKey), this.ryvoChannelActiveSetKey()],
      [params.settledCumulative, now, params.channelKey],
    );
    return { fullyReconciled: Number(raw) === 1 };
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
  // single-use. Ryvo's Tokens routes are read-only and rely on the
  // signed `expirationTime` (default 5 min) for replay protection,
  // which is the same guarantee the Coinbase x402 reference server
  // ships with by default. Leaving these methods undefined lets the
  // SIWX hook treat valid signed headers as TTL-bounded bearers and
  // gives clients (CLI, MCP, browser) the playground-equivalent
  // latency the protocol was designed for.

  private replayKey(key: string): string {
    return `replay:${key}`;
  }

  private ryvoChannelLedgerKey(channelKey: string): string {
    return `ryvo-channel:ledger:${this.hashKey(channelKey)}`;
  }

  private ryvoChannelRequestKey(requestHash: string): string {
    return `ryvo-channel:request:${requestHash}`;
  }

  private ryvoChannelActiveSetKey(): string {
    return "ryvo-channel:active";
  }

  private hashKey(input: string): string {
    return createHash("sha256").update(input).digest("hex");
  }
}
