import * as anchor from "@coral-xyz/anchor";
import bs58 from "bs58";
import {
  type CommitmentEntry,
  type GatewayCommitmentPayload,
  RyvoClient,
  createGatewayCommitmentMessage,
  decodeGatewayCommitmentEnvelope,
} from "@ryvonetwork/sdk";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { loadConfig } from "./config";
import { HostedGatewayState, type RyvoChannelLedgerWithKey } from "./hosted-state";
import { logEvent } from "./hosted-logger";
import type { GatewayConfig } from "./types";

export interface SettlementCycleSummary {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  channelsScanned: number;
  channelsEligible: number;
  bundlesSubmitted: number;
  individualsSubmitted: number;
  channelsSettled: number;
  channelsSkipped: number;
  errors: Array<{ channelKey: string; reason: string }>;
  transactions: string[];
}

interface EligibleChannel {
  ledger: RyvoChannelLedgerWithKey;
  envelope: GatewayCommitmentPayload;
  payerParticipantId: number;
  payeeParticipantId: number;
  tokenId: number;
  channelBucket: PublicKey;
  authorizedSigner: PublicKey;
  /** The fully-signed off-chain commitment. */
  commitment: CommitmentEntry;
  /** Pre-cached bytes that the payer signed (for ed25519 verify ix). */
  messageBytes: Buffer;
  /** Cumulative on-chain settled amount last seen. */
  lastSettledCumulative: bigint;
  /** Latest accepted off-chain commitment (= what we will settle to). */
  latestAcceptedCommitted: bigint;
  /** Delta between latest accepted and last on-chain settled. */
  delta: bigint;
  /** Seconds since the oldest unsettled commitment was admitted. */
  ageSeconds: number;
}

function parseFacilitatorKeypair(config: GatewayConfig): Keypair {
  if (!config.facilitatorWalletBase58) {
    throw new Error(
      "RYVO_FACILITATOR_WALLET_BASE58 is required for the Ryvo settler.",
    );
  }
  const bytes = bs58.decode(config.facilitatorWalletBase58.trim());
  if (bytes.length !== 64) {
    throw new Error(
      "RYVO_FACILITATOR_WALLET_BASE58 must decode to a 64-byte Solana secret key.",
    );
  }
  return Keypair.fromSecretKey(bytes);
}

function createSettlerClient(config: GatewayConfig, signer: Keypair): RyvoClient {
  if (!config.ryvoProtocolProgramId) {
    throw new Error("RYVO_PROTOCOL_PROGRAM_ID is required for the Ryvo settler.");
  }
  const connection = new Connection(config.solanaDevnetRpcUrl, "confirmed");
  const wallet = new anchor.Wallet(signer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  return new RyvoClient({
    provider,
    programId: new PublicKey(config.ryvoProtocolProgramId),
  });
}

function parseTokenAmount(value: string | null | undefined): bigint {
  if (!value || value.trim().length === 0) return 0n;
  return BigInt(value.trim());
}

function parseDecimalAmount(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid decimal token amount: ${value}`);
  }
  const [whole, fractional = ""] = trimmed.split(".");
  const padded = fractional.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

/**
 * Scan the active-channel set, fetch the lane snapshot for each, and decide
 * which ones are worth settling this cycle.
 *
 * Eligibility rules:
 * - Has a non-empty `latestEnvelope` (off-chain commitment) and the
 *   off-chain commit is strictly greater than the on-chain settled cumulative.
 * - Either `delta >= minDelta` OR `oldestUnsettledAcceptedAt` age has exceeded
 *   `forceSweepAfter` (so we always sweep within the SLA even if traffic is
 *   tiny).
 */
async function buildEligibleChannelSet(params: {
  config: GatewayConfig;
  state: HostedGatewayState;
  client: RyvoClient;
  channelKeys: string[];
}): Promise<{ eligible: EligibleChannel[]; skipped: EligibleChannel[]; errors: Array<{ channelKey: string; reason: string }> }> {
  const { config, state, client, channelKeys } = params;
  const minDelta = parseDecimalAmount(config.ryvoChannelSettlementMinDelta, 6);
  const forceSweepMs = config.ryvoSettlerForceSweepAfterSeconds * 1000;

  const ledgers = await state.getRyvoChannelLedgersBatch(channelKeys);
  const eligible: EligibleChannel[] = [];
  const skipped: EligibleChannel[] = [];
  const errors: Array<{ channelKey: string; reason: string }> = [];

  for (const ledger of ledgers) {
    try {
      if (!ledger.latestEnvelope) {
        skipped.push({} as EligibleChannel);
        continue;
      }
      if (
        !ledger.payerParticipantId
        || !ledger.payeeParticipantId
        || !ledger.tokenId
        || !ledger.channelBucket
      ) {
        errors.push({ channelKey: ledger.channelKey, reason: "ledger_metadata_missing" });
        continue;
      }
      const envelope = decodeGatewayCommitmentEnvelope(ledger.latestEnvelope);
      const messageBytes = createGatewayCommitmentMessage(envelope);
      if (!envelope.signature) {
        errors.push({ channelKey: ledger.channelKey, reason: "envelope_missing_signature" });
        continue;
      }
      const signature = Buffer.from(envelope.signature, "base64");
      const signerPubkey = new PublicKey(envelope.signer);

      // Re-fetch the on-chain lane to get an authoritative settledCumulative.
      const lane = await client.fetchChannelByParticipantIds(
        Number(ledger.payerParticipantId),
        Number(ledger.payeeParticipantId),
        Number(ledger.tokenId),
      );
      if (!lane) {
        errors.push({ channelKey: ledger.channelKey, reason: "channel_not_found_onchain" });
        continue;
      }

      const lastSettledCumulative = lane.lane.settledCumulative;
      const latestAcceptedCommitted = parseTokenAmount(ledger.latestAcceptedCommitted);
      if (latestAcceptedCommitted <= lastSettledCumulative) {
        // Already settled (probably by a previous cycle or another writer).
        // Reconcile the ledger and drop it from the active set.
        await state.markRyvoChannelSettled({
          channelKey: ledger.channelKey,
          settledCumulative: lastSettledCumulative.toString(),
        });
        continue;
      }

      const delta = latestAcceptedCommitted - lastSettledCumulative;
      const oldestUnsettledMs = ledger.oldestUnsettledAcceptedAt
        ? Number(ledger.oldestUnsettledAcceptedAt)
        : Date.now();
      const ageMs = Date.now() - oldestUnsettledMs;
      const ageSeconds = Math.max(0, Math.floor(ageMs / 1000));

      const candidate: EligibleChannel = {
        ledger,
        envelope,
        payerParticipantId: Number(ledger.payerParticipantId),
        payeeParticipantId: Number(ledger.payeeParticipantId),
        tokenId: Number(ledger.tokenId),
        channelBucket: lane.channelBucketPda,
        authorizedSigner: lane.lane.authorizedSigner,
        commitment: {
          payerParticipantId: Number(ledger.payerParticipantId),
          committedAmount: latestAcceptedCommitted.toString(),
          signature,
          signerPubkey,
          messageBytes,
        },
        messageBytes,
        lastSettledCumulative,
        latestAcceptedCommitted,
        delta,
        ageSeconds,
      };

      const meetsThreshold = delta >= minDelta;
      const ageExceeded = ageMs >= forceSweepMs;
      if (meetsThreshold || ageExceeded) {
        eligible.push(candidate);
      } else {
        skipped.push(candidate);
      }
    } catch (error) {
      errors.push({
        channelKey: ledger.channelKey,
        reason: error instanceof Error ? error.message : "unknown_error",
      });
    }
  }

  return { eligible, skipped, errors };
}

/**
 * Group eligible channels by `(payeeParticipantId, tokenId)` so each group can
 * be settled in a single `settleCommitmentBundle` tx. We cap each group at
 * `ryvoSettlerMaxBundleSize` to stay safely within the program's u8 count and
 * compute-budget limits.
 */
function groupForBundles(
  channels: EligibleChannel[],
  maxBundleSize: number,
): Map<string, EligibleChannel[][]> {
  const groups = new Map<string, EligibleChannel[][]>();
  for (const channel of channels) {
    const key = `${channel.payeeParticipantId}:${channel.tokenId}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, [[channel]]);
      continue;
    }
    const last = existing[existing.length - 1]!;
    if (last.length >= maxBundleSize) {
      existing.push([channel]);
    } else {
      last.push(channel);
    }
  }
  return groups;
}

/**
 * Run a single settler cycle.
 *
 * Designed to be invoked from a Vercel Cron handler. Idempotent: if the cycle
 * is interrupted partway, the next invocation will pick up the remaining
 * channels because we only mark them settled after the on-chain transaction
 * is confirmed.
 */
export async function runSettlementCycle(
  overrides?: Partial<GatewayConfig>,
): Promise<SettlementCycleSummary> {
  const baseConfig = loadConfig();
  const config: GatewayConfig = { ...baseConfig, ...overrides };
  const state = new HostedGatewayState(config);

  const startedAt = new Date().toISOString();
  const summary: SettlementCycleSummary = {
    startedAt,
    finishedAt: startedAt,
    dryRun: config.ryvoSettlerDryRun,
    channelsScanned: 0,
    channelsEligible: 0,
    bundlesSubmitted: 0,
    individualsSubmitted: 0,
    channelsSettled: 0,
    channelsSkipped: 0,
    errors: [],
    transactions: [],
  };

  const facilitator = parseFacilitatorKeypair(config);
  const client = createSettlerClient(config, facilitator);

  const allActive = await state.listActiveRyvoChannels();
  const channelKeys = allActive.slice(0, config.ryvoSettlerMaxChannelsPerCycle);
  summary.channelsScanned = channelKeys.length;

  if (channelKeys.length === 0) {
    summary.finishedAt = new Date().toISOString();
    logEvent({
      event: "ryvo_settler_cycle_completed",
      timestamp: summary.finishedAt,
      requestId: "settler",
      detail: { ...summary },
    });
    return summary;
  }

  const { eligible, skipped, errors } = await buildEligibleChannelSet({
    config,
    state,
    client,
    channelKeys,
  });
  summary.channelsEligible = eligible.length;
  summary.channelsSkipped = skipped.length;
  summary.errors.push(...errors);

  if (config.ryvoSettlerDryRun) {
    summary.finishedAt = new Date().toISOString();
    logEvent({
      event: "ryvo_settler_cycle_completed",
      timestamp: summary.finishedAt,
      requestId: "settler",
      detail: { ...summary, dryRun: true, eligibleSample: eligible.slice(0, 3).map((entry) => ({
        channelKey: entry.ledger.channelKey,
        delta: entry.delta.toString(),
        ageSeconds: entry.ageSeconds,
        latestAcceptedCommitted: entry.latestAcceptedCommitted.toString(),
        lastSettledCumulative: entry.lastSettledCumulative.toString(),
      })) },
    });
    return summary;
  }

  const groups = groupForBundles(eligible, config.ryvoSettlerMaxBundleSize);

  for (const [groupKey, batches] of groups.entries()) {
    for (const batch of batches) {
      const [first] = batch;
      if (!first) continue;
      try {
        let signature: string;
        if (batch.length === 1) {
          const tx = await client.buildSettleIndividualTx({
            payerParticipantId: first.payerParticipantId,
            payeeParticipantId: first.payeeParticipantId,
            tokenId: first.tokenId,
            submitter: facilitator.publicKey,
            signature: first.commitment.signature as Uint8Array,
            signerPubkey: first.commitment.signerPubkey,
            messageBytes: first.messageBytes,
          });
          signature = await sendAndConfirmTransaction(
            client.connection,
            tx,
            [facilitator],
            { commitment: "confirmed" },
          );
          summary.individualsSubmitted += 1;
        } else {
          const tx = await client.buildSettleCommitmentBundleTx({
            payeeParticipantId: first.payeeParticipantId,
            tokenId: first.tokenId,
            submitter: facilitator.publicKey,
            commitments: batch.map((entry) => entry.commitment),
          });
          signature = await sendAndConfirmTransaction(
            client.connection,
            tx,
            [facilitator],
            { commitment: "confirmed" },
          );
          summary.bundlesSubmitted += 1;
        }
        summary.transactions.push(signature);

        for (const entry of batch) {
          const reconciliation = await state.markRyvoChannelSettled({
            channelKey: entry.ledger.channelKey,
            settledCumulative: entry.latestAcceptedCommitted.toString(),
          });
          if (reconciliation.fullyReconciled) {
            summary.channelsSettled += 1;
          }
        }

        logEvent({
          event: "ryvo_settler_batch_settled",
          timestamp: new Date().toISOString(),
          requestId: "settler",
          detail: {
            groupKey,
            batchSize: batch.length,
            transaction: signature,
            channels: batch.map((entry) => ({
              channelKey: entry.ledger.channelKey,
              committedAmount: entry.latestAcceptedCommitted.toString(),
              priorSettledCumulative: entry.lastSettledCumulative.toString(),
              delta: entry.delta.toString(),
            })),
          },
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown_error";
        for (const entry of batch) {
          summary.errors.push({ channelKey: entry.ledger.channelKey, reason });
        }
        logEvent({
          event: "ryvo_settler_batch_failed",
          timestamp: new Date().toISOString(),
          requestId: "settler",
          detail: {
            groupKey,
            batchSize: batch.length,
            reason,
          },
        });
      }
    }
  }

  summary.finishedAt = new Date().toISOString();
  logEvent({
    event: "ryvo_settler_cycle_completed",
    timestamp: summary.finishedAt,
    requestId: "settler",
    detail: { ...summary },
  });
  return summary;
}
