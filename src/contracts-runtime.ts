import type { IncomingHttpHeaders } from "node:http";

import type {
  GatewayPaymentEnvelope,
  GatewayRpcRequestContext,
} from "./types.js";

function requireHeader(
  headers: IncomingHttpHeaders,
  name: string
): string {
  const raw = headers[name.toLowerCase()];
  if (!raw) {
    throw new Error(`Missing required header ${name}`);
  }
  return Array.isArray(raw) ? raw[0] : raw;
}

function parseRequiredInt(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid ${field}: ${value}`);
  }
  return parsed;
}

function parseRequiredBigInt(value: string, field: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new Error(`Invalid ${field}: ${value}`);
  }
}

export function parseWalletAddress(headers: IncomingHttpHeaders): string {
  return requireHeader(headers, "x-wallet-address");
}

export function parseGatewayPaymentEnvelope(
  headers: IncomingHttpHeaders
): GatewayPaymentEnvelope {
  const signatureHex = requireHeader(headers, "x-agon-signature");
  if (!signatureHex.startsWith("0x")) {
    throw new Error("x-agon-signature must be hex-prefixed");
  }

  return {
    payerId: parseRequiredInt(requireHeader(headers, "x-agon-payer-id"), "payer id"),
    payeeId: parseRequiredInt(requireHeader(headers, "x-agon-payee-id"), "payee id"),
    tokenId: parseRequiredInt(requireHeader(headers, "x-agon-token-id"), "token id"),
    committedAmount: parseRequiredBigInt(
      requireHeader(headers, "x-agon-committed-amount"),
      "committed amount"
    ),
    signatureHex: signatureHex as `0x${string}`,
  };
}

export function buildRequestContext(params: {
  walletAddress: string;
  payment: GatewayPaymentEnvelope;
  settledCumulative: bigint;
  previousAcceptedCumulative: bigint;
  requestedPrice: bigint;
  lockedBalance: bigint;
}): GatewayRpcRequestContext {
  return {
    method: "",
    walletAddress: params.walletAddress,
    payerId: params.payment.payerId,
    payeeId: params.payment.payeeId,
    tokenId: params.payment.tokenId,
    committedAmount: params.payment.committedAmount,
    settledCumulative: params.settledCumulative,
    previousAcceptedCumulative: params.previousAcceptedCumulative,
    requestedPrice: params.requestedPrice,
    lockedBalance: params.lockedBalance,
  };
}
