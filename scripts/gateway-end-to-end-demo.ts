#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * End-to-end Ryvo Gateway demo.
 *
 * Walks through the full payment-channel happy path against a deployed gateway
 * (defaults to http://localhost:8080) and the deployed Ryvo program on devnet:
 *
 *   1. Loads the deployment manifest + merchant/payer keypairs from disk.
 *   2. Confirms the gateway exposes ryvo-channel routes (catalog probe).
 *   3. Ensures the payer has a participant + a channel with enough headroom
 *      (deposit + create_channel + lock_channel_funds; no-ops if already set up).
 *   4. Issues N RPC calls through the gateway, each one signed by the payer.
 *   5. Optionally triggers the settler (POST /api/internal/settler/run) to
 *      verify the on-chain settled cumulative is updated.
 *
 * Required env:
 *   RYVO_GATEWAY_BASE_URL              http(s) URL of the gateway (default http://localhost:8080)
 *   RYVO_PROTOCOL_DEVNET_DEPLOYMENT_CONFIG  path to deployments/devnet/colosseum-basic-setup.json
 *   RYVO_DEMO_PAYER_KEYPAIR            path to a Solana keypair JSON (defaults to participant-01)
 *   RYVO_INTERNAL_SETTLEMENT_SECRET    (optional) trigger settler at end of run
 *   SOLANA_DEVNET_RPC_URL              (optional) RPC endpoint
 *
 * Usage:
 *   pnpm tsx scripts/gateway-end-to-end-demo.ts --calls 3 --settle
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as anchor from "@coral-xyz/anchor";
import {
  buildGatewayCommitmentPayload,
  createGatewayCommitmentMessage,
  encodeGatewayCommitmentEnvelope,
  RyvoClient,
  toAnchorBn,
} from "@ryvonetwork/sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import nacl from "tweetnacl";

interface CliArgs {
  calls: number;
  pricePerCall: string;
  settle: boolean;
  baseUrl: string;
  routePath: string;
}

interface DeploymentManifest {
  rpcUrl: string;
  program: { ryvoProtocol: string; chainId: number };
  wallets: {
    keysDirectory: string;
    merchant: { publicKey: string; participantId: number };
    participants: Array<{ label: string; publicKey: string; participantId: number; keypairPath: string }>;
  };
  tokens: Array<{ tokenId: number; symbol: string; mint: string; decimals: number }>;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    calls: 3,
    pricePerCall: "0.01",
    settle: false,
    baseUrl: process.env.RYVO_GATEWAY_BASE_URL ?? "http://localhost:8080",
    routePath: "/v1/ryvo-channel/solana/devnet/helius/rpc/getBalance",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--calls") args.calls = Number(argv[++i] ?? args.calls);
    else if (arg === "--price") args.pricePerCall = argv[++i] ?? args.pricePerCall;
    else if (arg === "--settle") args.settle = true;
    else if (arg === "--base-url") args.baseUrl = argv[++i] ?? args.baseUrl;
    else if (arg === "--route") args.routePath = argv[++i] ?? args.routePath;
  }
  if (!Number.isInteger(args.calls) || args.calls < 1) {
    throw new Error("--calls must be a positive integer.");
  }
  return args;
}

function loadKeypair(jsonPath: string): Keypair {
  if (!existsSync(jsonPath)) {
    throw new Error(`Keypair not found: ${jsonPath}`);
  }
  const raw = JSON.parse(readFileSync(jsonPath, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function decimalToBaseUnits(decimal: string, decimals: number): bigint {
  const trimmed = decimal.trim();
  const [whole, fractional = ""] = trimmed.split(".");
  const padded = fractional.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

function logStep(label: string, payload?: Record<string, unknown>) {
  console.log(`\n=== ${label} ===`);
  if (payload) console.log(JSON.stringify(payload, null, 2));
}

async function ensureParticipantAndChannel(params: {
  client: RyvoClient;
  payer: Keypair;
  payeeOwner: PublicKey;
  payeeParticipantId: number;
  tokenId: number;
  tokenMint: PublicKey;
  desiredLockBaseUnits: bigint;
}): Promise<{ payerParticipantId: number; channelBucket: PublicKey }> {
  const { client, payer, payeeOwner, payeeParticipantId, tokenId, tokenMint, desiredLockBaseUnits } = params;

  let payerParticipantId = await client.findParticipantIdForOwner(payer.publicKey);
  if (payerParticipantId === null) {
    logStep("registering payer participant");
    const config = await client.fetchGlobalConfig();
    const ix = await client.buildInitializeParticipantIx({
      owner: payer.publicKey,
      feeRecipient: config.feeRecipient,
    });
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(client.connection, tx, [payer], { commitment: "confirmed" });
    console.log(`  initializeParticipant tx: ${sig}`);
    payerParticipantId = await client.findParticipantIdForOwner(payer.publicKey);
    if (payerParticipantId === null) {
      throw new Error("Failed to register payer participant.");
    }
  }
  console.log(`  payer participant id: ${payerParticipantId}`);

  let lane = await client.fetchChannelByParticipantIds(payerParticipantId, payeeParticipantId, tokenId);
  if (!lane) {
    logStep("creating channel + payee consent (no-op if payee already consented)");
    const ix = await client.buildCreateChannelIx({
      payerOwner: payer.publicKey,
      payeeOwner,
      tokenId,
      authorizedSigner: payer.publicKey,
      requirePayeeConsent: false,
    });
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(client.connection, tx, [payer], { commitment: "confirmed" });
    console.log(`  createChannel tx: ${sig}`);
    lane = await client.fetchChannelByParticipantIds(payerParticipantId, payeeParticipantId, tokenId);
    if (!lane) {
      throw new Error("Channel still missing after createChannel.");
    }
  }
  console.log(`  channel bucket: ${lane.channelBucketPda.toBase58()}`);
  console.log(`  authorized signer: ${lane.lane.authorizedSigner.toBase58()}`);
  console.log(`  settledCumulative: ${lane.lane.settledCumulative}`);
  console.log(`  lockedBalance: ${lane.lane.lockedBalance}`);

  const headroom = lane.lane.lockedBalance - lane.lane.pendingUnlockAmount;
  if (headroom < desiredLockBaseUnits) {
    const toLock = desiredLockBaseUnits - headroom;
    logStep("topping up channel funds", {
      tokenId,
      additionalLockBaseUnits: toLock.toString(),
    });

    // Ensure deposit balance is high enough first.
    const participant = await client.fetchParticipantById(payerParticipantId);
    const balance = participant.slot?.tokenBalances
      .find((entry) => entry.initialized && entry.tokenId === tokenId)
      ?.availableBalance ?? 0n;
    if (balance < toLock) {
      const need = toLock - balance;
      const ata = getAssociatedTokenAddressSync(tokenMint, payer.publicKey);
      const ix = await client.buildDepositIx({
        owner: payer.publicKey,
        ownerTokenAccount: ata,
        tokenId,
        amount: toAnchorBn(need),
      });
      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(client.connection, tx, [payer], { commitment: "confirmed" });
      console.log(`  deposit tx: ${sig}`);
    }

    const lockIx = await client.buildLockChannelFundsIx({
      owner: payer.publicKey,
      payeeParticipantId,
      tokenId,
      amount: toAnchorBn(toLock),
    });
    const lockTx = new Transaction().add(lockIx);
    const lockSig = await sendAndConfirmTransaction(client.connection, lockTx, [payer], { commitment: "confirmed" });
    console.log(`  lockChannelFunds tx: ${lockSig}`);
    lane = await client.fetchChannelByParticipantIds(payerParticipantId, payeeParticipantId, tokenId);
    if (!lane) {
      throw new Error("Channel disappeared after locking funds.");
    }
  }

  return {
    payerParticipantId: lane.payerParticipantId,
    channelBucket: lane.channelBucketPda,
  };
}

function signCommitment(payer: Keypair, payload: ReturnType<typeof buildGatewayCommitmentPayload>) {
  const message = createGatewayCommitmentMessage(payload);
  const signature = nacl.sign.detached(message, payer.secretKey);
  const signed = { ...payload, signature: Buffer.from(signature).toString("base64") };
  return { signed, envelope: encodeGatewayCommitmentEnvelope(signed) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const deploymentPath = process.env.RYVO_PROTOCOL_DEVNET_DEPLOYMENT_CONFIG
    ?? "/home/heis/ryvo/ryvo-protocol/deployments/devnet/colosseum-basic-setup.json";
  if (!existsSync(deploymentPath)) {
    throw new Error(`Deployment manifest not found: ${deploymentPath}`);
  }
  const deployment = JSON.parse(readFileSync(deploymentPath, "utf8")) as DeploymentManifest;

  const programId = new PublicKey(deployment.program.ryvoProtocol);
  const merchant = deployment.wallets.merchant;
  const payerKeypairPath = process.env.RYVO_DEMO_PAYER_KEYPAIR
    ?? resolve(deploymentPath, "..", "..", "..", deployment.wallets.participants[0]?.keypairPath ?? "");
  const payer = loadKeypair(payerKeypairPath);

  const usdc = deployment.tokens.find((entry) => entry.symbol === "USDC");
  if (!usdc) throw new Error("USDC token not registered in deployment manifest.");
  const tokenId = usdc.tokenId;
  const tokenMint = new PublicKey(usdc.mint);
  const tokenDecimals = usdc.decimals;

  const rpcUrl = process.env.SOLANA_DEVNET_RPC_URL ?? deployment.rpcUrl;
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const client = new RyvoClient({ provider, programId });

  logStep("demo configuration", {
    gateway: args.baseUrl,
    routePath: args.routePath,
    calls: args.calls,
    pricePerCall: args.pricePerCall,
    payer: payer.publicKey.toBase58(),
    merchant: merchant.publicKey,
    tokenMint: tokenMint.toBase58(),
    chainId: deployment.program.chainId,
  });

  // 1. Catalog probe — confirm the gateway has ryvo-channel routes wired up.
  const catalogResp = await fetch(`${args.baseUrl}/v1/catalog`);
  if (!catalogResp.ok) {
    throw new Error(`Gateway catalog probe failed: ${catalogResp.status}`);
  }
  const catalog = await catalogResp.json() as {
    payment: { modes: string[] };
    routes: Array<{ path: string; accessMode: string; tokenId?: number; merchantParticipantId?: number; programId?: string; messageDomain?: string }>;
  };
  const route = catalog.routes.find((r) => r.path === args.routePath && r.accessMode === "ryvo-channel");
  if (!route) {
    throw new Error(`Gateway does not expose ryvo-channel route ${args.routePath}.`);
  }
  if (route.tokenId !== tokenId || route.merchantParticipantId !== merchant.participantId) {
    throw new Error("Gateway route metadata does not match deployment manifest.");
  }
  console.log(`  gateway exposes ${args.routePath}`);
  console.log(`  payment modes: ${catalog.payment.modes.join(", ")}`);

  // 2. Make sure payer has a participant + a channel with enough headroom.
  const totalNeeded = decimalToBaseUnits(args.pricePerCall, tokenDecimals) * BigInt(args.calls + 1);
  await ensureParticipantAndChannel({
    client,
    payer,
    payeeOwner: new PublicKey(merchant.publicKey),
    payeeParticipantId: merchant.participantId,
    tokenId,
    tokenMint,
    desiredLockBaseUnits: totalNeeded,
  });

  // 3. Send N gated RPC calls. Each commitment is cumulative (price * i).
  const priceUnits = decimalToBaseUnits(args.pricePerCall, tokenDecimals);
  const lane = await client.fetchChannelByParticipantIds(
    (await client.findParticipantIdForOwner(payer.publicKey))!,
    merchant.participantId,
    tokenId,
  );
  if (!lane) throw new Error("Channel disappeared before issuing calls.");
  let cumulative = lane.lane.settledCumulative;
  for (let callIdx = 1; callIdx <= args.calls; callIdx += 1) {
    cumulative += priceUnits;
    const payload = buildGatewayCommitmentPayload({
      cluster: "devnet",
      programId,
      chainId: deployment.program.chainId,
      tokenId,
      tokenMint,
      tokenDecimals,
      payerId: lane.payerParticipantId,
      payeeId: lane.payeeParticipantId,
      committedAmount: cumulative,
      authorizedSettler: null,
      signer: payer.publicKey,
    });
    const { envelope } = signCommitment(payer, payload);
    const requestId = `demo-${Date.now()}-${callIdx}`;
    const callResp = await fetch(`${args.baseUrl}${args.routePath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ryvo-request-id": requestId,
        "ryvo-commitment": envelope,
      },
      body: JSON.stringify({ params: [payer.publicKey.toBase58()] }),
    });
    const callBody = await callResp.json();
    logStep(`call ${callIdx}`, {
      status: callResp.status,
      requestId,
      cumulative: cumulative.toString(),
      response: callBody,
    });
    if (!callResp.ok) {
      throw new Error(`Gated RPC call ${callIdx} failed.`);
    }
  }

  // 4. Optionally trigger the settler endpoint manually.
  if (args.settle) {
    const internalSecret = process.env.RYVO_INTERNAL_SETTLEMENT_SECRET;
    if (!internalSecret) {
      throw new Error("--settle requires RYVO_INTERNAL_SETTLEMENT_SECRET.");
    }
    logStep("triggering settler");
    const resp = await fetch(`${args.baseUrl}/api/internal/settler/run`, {
      method: "POST",
      headers: { "x-ryvo-internal-secret": internalSecret },
    });
    const body = await resp.json();
    console.log(JSON.stringify(body, null, 2));

    // Verify on-chain settled cumulative caught up.
    const after = await client.fetchChannelByParticipantIds(
      lane.payerParticipantId,
      lane.payeeParticipantId,
      tokenId,
    );
    logStep("on-chain lane after settlement", {
      settledCumulative: after?.lane.settledCumulative.toString(),
      lockedBalance: after?.lane.lockedBalance.toString(),
    });
  }

  console.log("\nDemo complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
