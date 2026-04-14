import http, { type IncomingMessage, type ServerResponse } from "node:http";
import crypto from "node:crypto";

import { AgonGatewayAdmin } from "./agon-admin.js";
import { verifyCommitmentSignatureV4 } from "./agon-message.js";
import { AgonStateReader } from "./agon-state.js";
import type {
  X402TopUpConfirmRequest,
  X402TopUpConfirmResponse,
  RpcGatewayPaymentRequiredResponse,
  RpcGatewayRequestBody,
  RpcGatewaySuccessResponse,
  X402TopUpQuoteResponse,
} from "./contracts.js";
import { GATEWAY_ROUTES } from "./contracts.js";
import { loadGatewayConfig } from "./config.js";
import { buildRequestContext, parseGatewayPaymentEnvelope, parseWalletAddress } from "./contracts-runtime.js";
import { evaluateGatewayPreconditions } from "./flow.js";
import { sendJson, readJsonBody, notFound } from "./http.js";
import { getMicroAgonPriceForMethod } from "./pricing.js";
import { GatewayStateStore } from "./state.js";
import type {
  GatewaySettlementCandidate,
  GatewaySessionRecord,
  GatewayTopUpQuoteRecord,
  GatewayUsageRecord,
} from "./types.js";
import { forwardRpcToAlchemy } from "./alchemy.js";

const config = loadGatewayConfig();
const store = new GatewayStateStore(config.storagePath);
const agonState = new AgonStateReader(config);
const admin = config.operatorWalletPath ? new AgonGatewayAdmin(config) : null;

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function paymentRequiredNextAction(
  code: RpcGatewayPaymentRequiredResponse["code"]
): RpcGatewayPaymentRequiredResponse["nextAction"] {
  switch (code) {
    case "missing-participant":
      return "register-participant";
    case "missing-channel":
      return "create-channel";
    case "missing-locked-funds":
    case "insufficient-locked-funds":
      return "lock-funds";
    case "invalid-signature":
      return "sign-payment";
    case "insufficient-commitment":
    case "non-monotonic-commitment":
      return "top-up-via-x402";
    default:
      return "top-up-via-x402";
  }
}

function isQuoteExpired(quote: GatewayTopUpQuoteRecord): boolean {
  return Date.now() > new Date(quote.expiresAt).getTime();
}

async function collectSettlementCandidates(
  walletAddress?: string
): Promise<GatewaySettlementCandidate[]> {
  const sessions = store
    .listSessions()
    .filter((session) => (walletAddress ? session.walletAddress === walletAddress : true))
    .filter((session) => session.latestAcceptedCommitment !== undefined);

  const candidates: GatewaySettlementCandidate[] = [];
  for (const session of sessions) {
    const commitment = session.latestAcceptedCommitment;
    if (!commitment) continue;

    const liveState = await agonState.loadGatewayState(session.walletAddress);
    if (!liveState.participant || !liveState.channel) continue;
    if (liveState.channel.payeeId !== commitment.payeeId) continue;
    if (liveState.channel.tokenId !== commitment.tokenId) continue;
    if (commitment.committedAmount <= liveState.channel.settledCumulative) continue;

    candidates.push({
      walletAddress: session.walletAddress,
      payerId: commitment.payerId,
      payeeId: commitment.payeeId,
      tokenId: commitment.tokenId,
      authorizedSigner: commitment.authorizedSigner,
      signatureHex: commitment.signatureHex,
      committedAmount: commitment.committedAmount,
      settledCumulative: liveState.channel.settledCumulative,
      pendingDelta: commitment.committedAmount - liveState.channel.settledCumulative,
      payerParticipantPda: liveState.participant.participantPda,
      channelPda: liveState.channel.channelPda,
      acceptedAt: commitment.acceptedAt,
      rpcMethod: commitment.rpcMethod,
    });
  }

  return candidates;
}

async function handleHealth(_request: IncomingMessage, response: ServerResponse) {
  sendJson(response, 200, {
    ok: true,
    service: "agon-gateway",
    upstream: "alchemy-solana",
    port: config.port,
    acceptedPayeeId: config.gatewayPayeeId,
    acceptedTokenId: config.tokenId,
    acceptedTokenSymbol: config.tokenSymbol,
    acceptedTokenMint: config.tokenMint ?? null,
  });
}

async function handleSession(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "GET") {
    sendJson(response, 405, { ok: false, code: "method-not-allowed" });
    return;
  }

  const walletAddress = new URL(request.url ?? "", "http://localhost").searchParams.get(
    "walletAddress"
  );
  if (!walletAddress) {
    sendJson(response, 400, {
      ok: false,
      code: "missing-wallet-address",
      reason: "walletAddress query param is required",
    });
    return;
  }

  try {
    const liveState = await agonState.loadGatewayState(walletAddress);
    const localSession = store.getSession(walletAddress);
    const previousAcceptedCumulative = maxBigInt(
      localSession?.latestAcceptedCumulative ?? 0n,
      liveState.channel?.settledCumulative ?? 0n
    );

    sendJson(response, 200, {
      ok: true,
      walletAddress,
      liveState: {
        participant: liveState.participant
          ? {
              ...liveState.participant,
              availableBalance: liveState.participant.availableBalance.toString(),
              withdrawingBalance: liveState.participant.withdrawingBalance.toString(),
              totalBalance: liveState.participant.totalBalance.toString(),
            }
          : null,
        channel: liveState.channel
          ? {
              ...liveState.channel,
              settledCumulative: liveState.channel.settledCumulative.toString(),
              lockedBalance: liveState.channel.lockedBalance.toString(),
              pendingUnlockAmount: liveState.channel.pendingUnlockAmount.toString(),
              unlockRequestedAt: liveState.channel.unlockRequestedAt.toString(),
              authorizedSignerUpdateRequestedAt:
                liveState.channel.authorizedSignerUpdateRequestedAt.toString(),
            }
          : null,
      },
      trackedState: localSession
        ? {
            latestAcceptedCumulative: localSession.latestAcceptedCumulative.toString(),
            updatedAt: localSession.updatedAt,
          }
        : null,
      effectivePreviousAcceptedCumulative: previousAcceptedCumulative.toString(),
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      code: "invalid-wallet-address",
      reason: error instanceof Error ? error.message : "Unknown wallet lookup failure",
    });
  }
}

async function handleTopUpQuote(
  request: IncomingMessage,
  response: ServerResponse
) {
  if (request.method !== "GET") {
    sendJson(response, 405, { ok: false, code: "method-not-allowed" });
    return;
  }

  const walletAddress = new URL(request.url ?? "", "http://localhost").searchParams.get(
    "walletAddress"
  );
  if (!walletAddress) {
    sendJson(response, 400, {
      ok: false,
      code: "missing-wallet-address",
      reason: "walletAddress query param is required",
    });
    return;
  }

  const unitsParam = new URL(request.url ?? "", "http://localhost").searchParams.get(
    "units"
  );
  const quotedUnits = unitsParam ? BigInt(unitsParam) : config.topUpDefaultUnits;
  const quoteRecord: GatewayTopUpQuoteRecord = {
    id: crypto.randomUUID(),
    walletAddress,
    quotedUnits,
    quotedMicroAgon: Number(quotedUnits),
    fundedSolLamports: config.topUpBonusSolLamports,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(
      Date.now() + config.topUpQuoteTtlSeconds * 1000
    ).toISOString(),
  };
  store.issueTopUpQuote(quoteRecord);

  const quote = {
    ok: true,
    paymentMethod: "x402",
    quoteId: quoteRecord.id,
    walletAddress,
    tokenId: config.tokenId,
    tokenSymbol: config.tokenSymbol,
    tokenMint: config.tokenMint ?? null,
    quotedUnits: quoteRecord.quotedUnits,
    quotedMicroAgon: quoteRecord.quotedMicroAgon,
    fundedSolLamports: quoteRecord.fundedSolLamports,
    expiresAt: quoteRecord.expiresAt,
    note: `Confirm this x402 quote to receive ${config.tokenSymbol}, then deposit and lock it into your Agon lane.`,
  } satisfies X402TopUpQuoteResponse;
  sendJson(response, 200, quote);
}

async function handleTopUpConfirm(
  request: IncomingMessage,
  response: ServerResponse
) {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, code: "method-not-allowed" });
    return;
  }

  if (!admin) {
    sendJson(response, 501, {
      ok: false,
      code: "topups-disabled",
      reason: "Gateway operator wallet is not configured for demo top-ups.",
    });
    return;
  }

  const body = await readJsonBody<X402TopUpConfirmRequest>(request);
  const quote = store.getTopUpQuote(body.quoteId);
  if (!quote) {
    sendJson(response, 404, {
      ok: false,
      code: "quote-not-found",
      reason: `No x402 quote found for id ${body.quoteId}`,
    });
    return;
  }

  if (quote.consumedAt) {
    sendJson(response, 409, {
      ok: false,
      code: "quote-already-consumed",
      reason: `Quote ${quote.id} has already been used.`,
    });
    return;
  }

  if (isQuoteExpired(quote)) {
    sendJson(response, 410, {
      ok: false,
      code: "quote-expired",
      reason: `Quote ${quote.id} has expired.`,
    });
    return;
  }

  const transferResult = await admin.topUpWallet({
    walletAddress: quote.walletAddress,
    tokenUnits: quote.quotedUnits,
    solLamports: quote.fundedSolLamports,
  });

  const updatedQuote: GatewayTopUpQuoteRecord = {
    ...quote,
    consumedAt: new Date().toISOString(),
    tokenTransferSignature: transferResult.tokenTransferSignature,
    solTransferSignature: transferResult.solTransferSignature,
  };
  store.upsertTopUpQuote(updatedQuote);

  const result: X402TopUpConfirmResponse = {
    ok: true,
    quoteId: updatedQuote.id,
    walletAddress: updatedQuote.walletAddress,
    tokenSymbol: config.tokenSymbol,
    tokenMint: config.tokenMint ?? null,
    fundedUnits: updatedQuote.quotedUnits,
    fundedSolLamports: updatedQuote.fundedSolLamports,
    tokenTransferSignature: transferResult.tokenTransferSignature,
    solTransferSignature: transferResult.solTransferSignature,
    nextAction: "deposit",
  };

  sendJson(response, 200, result);
}

async function handleSettlementPreview(
  request: IncomingMessage,
  response: ServerResponse
) {
  const walletAddress = new URL(request.url ?? "", "http://localhost").searchParams.get(
    "walletAddress"
  ) ?? undefined;
  const pending = await collectSettlementCandidates(walletAddress);
  sendJson(response, 200, {
    ok: true,
    pendingCount: pending.length,
    pendingWalletCount: new Set(pending.map((entry) => entry.walletAddress)).size,
    totalPendingDelta: pending.reduce((sum, entry) => sum + entry.pendingDelta, 0n),
    pending,
    usage: store
      .listUsage(50)
      .filter((usage) => (walletAddress ? usage.walletAddress === walletAddress : true)),
  });
}

async function handleSettlementRun(
  request: IncomingMessage,
  response: ServerResponse
) {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, code: "method-not-allowed" });
    return;
  }

  if (!admin) {
    sendJson(response, 501, {
      ok: false,
      code: "settlement-disabled",
      reason: "Gateway operator wallet is not configured for bundle settlement.",
    });
    return;
  }

  const body = await readJsonBody<{ walletAddress?: string }>(request);
  const pending = await collectSettlementCandidates(body.walletAddress);
  if (pending.length === 0) {
    sendJson(response, 200, {
      ok: true,
      settledCount: 0,
      settlementSignature: null,
      pending,
    });
    return;
  }

  const settlementSignature = await admin.settleCommitmentBundle(pending);
  const settledAt = new Date().toISOString();
  for (const candidate of pending) {
    const existing = store.getSession(candidate.walletAddress);
    if (!existing) continue;
    store.upsertSession({
      ...existing,
      lastSettlementSignature: settlementSignature,
      lastSettledAt: settledAt,
      updatedAt: settledAt,
    });
  }

  sendJson(response, 200, {
    ok: true,
    settledCount: pending.length,
    settlementSignature,
    totalSettledDelta: pending.reduce((sum, entry) => sum + entry.pendingDelta, 0n),
    pending,
  });
}

async function handleRpc(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, code: "method-not-allowed" });
    return;
  }

  let walletAddress: string;
  let payment;
  try {
    walletAddress = parseWalletAddress(request.headers);
    payment = parseGatewayPaymentEnvelope(request.headers);
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      code: "invalid-payment-headers",
      reason: error instanceof Error ? error.message : "Unknown header parse failure",
    });
    return;
  }

  if (config.requireSignatureHex && payment.signatureHex.length <= 2) {
    sendJson(response, 400, {
      ok: false,
      code: "missing-signature",
      reason: "A hex signature is required for paid RPC requests.",
    });
    return;
  }

  const body = await readJsonBody<RpcGatewayRequestBody>(request);
  const session = store.getSession(walletAddress);
  const requestedPriceMicroAgon = BigInt(getMicroAgonPriceForMethod(body.method));

  let liveState;
  try {
    liveState = await agonState.loadGatewayState(walletAddress);
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "Unable to read Agon state";
    const code =
      error instanceof Error && /invalid public key/i.test(error.message)
        ? 400
        : 502;
    sendJson(response, code, {
      ok: false,
      code: code === 400 ? "invalid-wallet-address" : "agon-state-unavailable",
      reason,
    });
    return;
  }

  if (payment.payeeId !== config.gatewayPayeeId) {
    const denial: RpcGatewayPaymentRequiredResponse = {
      ok: false,
      code: "missing-channel",
      reason: `This gateway only accepts payments to payee ${config.gatewayPayeeId}.`,
      nextAction: "create-channel",
    };
    sendJson(response, 402, denial);
    return;
  }

  if (payment.tokenId !== config.tokenId) {
    const denial: RpcGatewayPaymentRequiredResponse = {
      ok: false,
      code: "missing-channel",
      reason: `This gateway only accepts ${config.tokenSymbol} payments on token id ${config.tokenId}.`,
      nextAction: "top-up-via-x402",
    };
    sendJson(response, 402, denial);
    return;
  }

  if (!liveState.participant) {
    const denial: RpcGatewayPaymentRequiredResponse = {
      ok: false,
      code: "missing-participant",
      reason: "User is not registered as an Agon participant yet.",
      nextAction: "register-participant",
    };
    sendJson(response, 402, denial);
    return;
  }

  if (payment.payerId !== liveState.participant.participantId) {
    sendJson(response, 400, {
      ok: false,
      code: "invalid-payer",
      reason: `Payment payer id ${payment.payerId} does not match the on-chain participant ${liveState.participant.participantId} for wallet ${walletAddress}.`,
    });
    return;
  }

  if (!liveState.channel) {
    const denial: RpcGatewayPaymentRequiredResponse = {
      ok: false,
      code: "missing-channel",
      reason: "No payment lane exists between the caller and Agon Gateway.",
      nextAction: "create-channel",
    };
    sendJson(response, 402, denial);
    return;
  }

  if (config.requireSignatureHex) {
    const isValidSignature = verifyCommitmentSignatureV4({
      messageDomain: agonState.messageDomain,
      payerId: payment.payerId,
      payeeId: payment.payeeId,
      tokenId: payment.tokenId,
      committedAmount: payment.committedAmount,
      signatureHex: payment.signatureHex,
      authorizedSigner: liveState.channel.authorizedSignerPubkey,
    });
    if (!isValidSignature) {
      const denial: RpcGatewayPaymentRequiredResponse = {
        ok: false,
        code: "invalid-signature",
        reason: "The signed Agon commitment does not verify against the lane's authorized signer.",
        nextAction: "sign-payment",
      };
      sendJson(response, 402, denial);
      return;
    }
  }

  const previousAcceptedCumulative = maxBigInt(
    session?.latestAcceptedCumulative ?? 0n,
    liveState.channel.settledCumulative
  );
  const context = buildRequestContext({
    walletAddress,
    payment,
    settledCumulative: liveState.channel.settledCumulative,
    previousAcceptedCumulative,
    requestedPrice: requestedPriceMicroAgon,
    lockedBalance: liveState.channel.lockedBalance,
  });
  context.method = body.method;

  const decision = evaluateGatewayPreconditions(context);
  if (!decision.allow) {
    const denial: RpcGatewayPaymentRequiredResponse = {
      ok: false,
      code: decision.code,
      reason: decision.reason,
      nextAction: paymentRequiredNextAction(decision.code),
    };
    sendJson(response, 402, denial);
    return;
  }

  const effectiveSession: GatewaySessionRecord = {
    walletAddress,
    payerId: payment.payerId,
    payeeId: payment.payeeId,
    tokenId: payment.tokenId,
    lockedBalance: liveState.channel.lockedBalance,
    availableBalance: liveState.participant.availableBalance,
    latestAcceptedCumulative: payment.committedAmount,
    authorizedSigner: liveState.channel.authorizedSigner,
    updatedAt: new Date().toISOString(),
    latestAcceptedCommitment: {
      payerId: payment.payerId,
      payeeId: payment.payeeId,
      tokenId: payment.tokenId,
      committedAmount: payment.committedAmount,
      signatureHex: payment.signatureHex,
      authorizedSigner: liveState.channel.authorizedSigner,
      acceptedAt: new Date().toISOString(),
      rpcMethod: body.method,
    },
    lastSettlementSignature: session?.lastSettlementSignature,
    lastSettledAt: session?.lastSettledAt,
  };
  store.upsertSession(effectiveSession);

  const usage: GatewayUsageRecord = {
    id: crypto.randomUUID(),
    walletAddress,
    method: body.method,
    microAgonPrice: Number(requestedPriceMicroAgon),
    previousAcceptedCumulative,
    newCommittedAmount: payment.committedAmount,
    createdAt: new Date().toISOString(),
  };
  store.recordUsage(usage);

  try {
    const result = await forwardRpcToAlchemy({
      alchemySolanaRpcUrl: config.alchemySolanaRpcUrl,
      requestBody: body,
    });

    const success: RpcGatewaySuccessResponse = {
      ok: true,
      upstream: "alchemy",
      method: body.method,
      chargedMicroAgon: Number(requestedPriceMicroAgon),
      result,
    };
    sendJson(response, 200, success);
  } catch (error) {
    sendJson(response, 502, {
      ok: false,
      code: "upstream-failure",
      reason:
        error instanceof Error ? error.message : "Unknown upstream failure",
    });
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse
) {
  const url = new URL(request.url ?? "/", "http://localhost");

  if (url.pathname === "/healthz") {
    await handleHealth(request, response);
    return;
  }

  if (url.pathname === GATEWAY_ROUTES.session) {
    await handleSession(request, response);
    return;
  }

  if (url.pathname === GATEWAY_ROUTES.topUpQuote) {
    await handleTopUpQuote(request, response);
    return;
  }

  if (url.pathname === GATEWAY_ROUTES.topUpConfirm) {
    await handleTopUpConfirm(request, response);
    return;
  }

  if (url.pathname === GATEWAY_ROUTES.settlementPreview) {
    await handleSettlementPreview(request, response);
    return;
  }

  if (url.pathname === GATEWAY_ROUTES.settlementRun) {
    await handleSettlementRun(request, response);
    return;
  }

  if (url.pathname === GATEWAY_ROUTES.rpc) {
    await handleRpc(request, response);
    return;
  }

  notFound(response);
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    sendJson(response, 500, {
      ok: false,
      code: "internal-error",
      reason: error instanceof Error ? error.message : "Unknown server error",
    });
  });
});

server.listen(config.port, () => {
  console.log(
    `Agon Gateway listening on http://localhost:${config.port} -> ${config.alchemySolanaRpcUrl} (payee=${config.gatewayPayeeId}, token=${config.tokenSymbol}:${config.tokenId})`
  );
});
