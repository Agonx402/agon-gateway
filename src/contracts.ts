import type { GatewayDecision, GatewayPaymentEnvelope } from "./types.js";

export const GATEWAY_ROUTES = {
  rpc: "/rpc",
  topUpQuote: "/topups/x402/quote",
  topUpConfirm: "/topups/x402/confirm",
  session: "/session",
  settlementPreview: "/settlement/preview",
  settlementRun: "/settlement/run",
} as const;

export interface RpcGatewayRequestBody {
  method: string;
  params: unknown[];
}

export interface RpcGatewaySuccessResponse {
  ok: true;
  upstream: "alchemy";
  method: string;
  chargedMicroAgon: number;
  result: unknown;
}

export interface RpcGatewayPaymentRequiredResponse {
  ok: false;
  code: GatewayDecision["code"];
  reason: string;
  nextAction:
    | "register-participant"
    | "deposit"
    | "create-channel"
    | "lock-funds"
    | "top-up-via-x402"
    | "sign-payment";
}

export interface RpcGatewayHeaders extends GatewayPaymentEnvelope {
  walletAddress: string;
}

export interface X402TopUpQuoteResponse {
  ok: true;
  paymentMethod: "x402";
  quoteId: string;
  walletAddress: string;
  tokenId: number;
  tokenSymbol: string;
  tokenMint: string | null;
  quotedUnits: bigint;
  quotedMicroAgon: number;
  fundedSolLamports: bigint;
  expiresAt: string;
  note: string;
}

export interface X402TopUpConfirmRequest {
  quoteId: string;
}

export interface X402TopUpConfirmResponse {
  ok: true;
  quoteId: string;
  walletAddress: string;
  tokenSymbol: string;
  tokenMint: string | null;
  fundedUnits: bigint;
  fundedSolLamports: bigint;
  tokenTransferSignature: string;
  solTransferSignature?: string;
  nextAction: "deposit";
}
