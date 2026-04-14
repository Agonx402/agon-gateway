export type SettlementMode = "locked-lane" | "prepaid-balance" | "trusted-credit";

export interface RpcMethodPrice {
  method: string;
  microAgonPrice: number;
  description: string;
}

export interface GatewayRouteConfig {
  path: string;
  upstreamBaseUrl: string;
  settlementMode: SettlementMode;
}

export interface GatewayBuyerState {
  walletAddress: string;
  participantId?: number;
  lockedBalance?: bigint;
  availableBalance?: bigint;
  latestAcceptedCumulative?: bigint;
}

export interface GatewayPaymentEnvelope {
  payerId: number;
  payeeId: number;
  tokenId: number;
  committedAmount: bigint;
  signatureHex: `0x${string}`;
}

export interface GatewayAcceptedCommitmentRecord
  extends GatewayPaymentEnvelope {
  authorizedSigner: string;
  acceptedAt: string;
  rpcMethod: string;
}

export interface GatewaySessionRecord {
  walletAddress: string;
  payerId: number;
  payeeId: number;
  tokenId: number;
  lockedBalance: bigint;
  availableBalance: bigint;
  latestAcceptedCumulative: bigint;
  authorizedSigner?: string;
  updatedAt: string;
  latestAcceptedCommitment?: GatewayAcceptedCommitmentRecord;
  lastSettlementSignature?: string;
  lastSettledAt?: string;
}

export interface GatewayRpcRequestContext {
  method: string;
  walletAddress: string;
  payerId?: number;
  payeeId?: number;
  tokenId?: number;
  committedAmount?: bigint;
  settledCumulative?: bigint;
  previousAcceptedCumulative?: bigint;
  requestedPrice?: bigint;
  lockedBalance?: bigint;
}

export interface GatewayDecision {
  allow: boolean;
  code:
    | "ok"
    | "missing-participant"
    | "missing-channel"
    | "missing-locked-funds"
    | "insufficient-locked-funds"
    | "insufficient-commitment"
    | "non-monotonic-commitment"
    | "invalid-payer"
    | "invalid-signature";
  reason: string;
}

export interface GatewayUsageRecord {
  id: string;
  walletAddress: string;
  method: string;
  microAgonPrice: number;
  previousAcceptedCumulative: bigint;
  newCommittedAmount: bigint;
  createdAt: string;
}

export interface GatewayTopUpQuoteRecord {
  id: string;
  walletAddress: string;
  quotedUnits: bigint;
  quotedMicroAgon: number;
  fundedSolLamports: bigint;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  tokenTransferSignature?: string;
  solTransferSignature?: string;
}

export interface GatewaySettlementCandidate {
  walletAddress: string;
  payerId: number;
  payeeId: number;
  tokenId: number;
  authorizedSigner: string;
  signatureHex: `0x${string}`;
  committedAmount: bigint;
  settledCumulative: bigint;
  pendingDelta: bigint;
  payerParticipantPda: string;
  channelPda: string;
  acceptedAt: string;
  rpcMethod: string;
}
