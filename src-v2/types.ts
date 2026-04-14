export type ProviderName = "alchemy" | "helius";
export type ClusterName = "mainnet" | "devnet";
export type SurfaceName = "rpc" | "das";
export type ParamsShape = "array" | "object";

export interface RouteSpec {
  path: string;
  cluster: ClusterName;
  provider: ProviderName;
  surface: SurfaceName;
  method: string;
  description: string;
  paramsShape: ParamsShape;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export interface CatalogRouteEntry {
  path: string;
  cluster: ClusterName;
  provider: ProviderName;
  surface: SurfaceName;
  method: string;
  description: string;
  priceUsd: string;
  paymentNetwork: string;
  paymentAsset: {
    symbol: string;
    mint: string;
    decimals: number;
  };
  enabled: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export interface PaymentAsset {
  address: string;
  symbol: string;
  decimals: number;
}

export interface PaymentRequirement {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  asset: PaymentAsset;
  facilitator: {
    url: string;
  };
  outputSchema?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface PaymentRequiredEnvelope {
  x402Version: 2;
  accepts: PaymentRequirement[];
}

export interface SettlementResponse {
  success: boolean;
  network: string;
  transaction?: string;
  payer?: string;
  error?: string;
  settledAt?: string;
}

export interface VerificationResult {
  success: boolean;
  error?: string;
  payer?: string;
  amountAtomic?: string;
  settlementCacheKey?: string;
}

export interface UpstreamResult {
  result: unknown;
  status: number;
}

export interface EventRecord {
  event: string;
  timestamp: string;
  requestId: string;
  routePath?: string;
  cluster?: ClusterName;
  provider?: ProviderName;
  surface?: SurfaceName;
  method?: string;
  wallet?: string;
  paymentNetwork?: string;
  paymentAsset?: string;
  priceUsd?: string;
  httpStatus?: number;
  upstreamLatencyMs?: number;
  detail?: Record<string, unknown>;
}

export interface GatewayConfig {
  port: number;
  baseUrl: string;
  eventLogPath: string;
  facilitatorWalletPath: string;
  internalSettlementSecret: string;
  payToWallet: string;
  usdcMint: string;
  priceUsd: string;
  priceAtomic: bigint;
  paymentNetwork: string;
  paymentAssetSymbol: string;
  paymentAssetDecimals: number;
  solanaMainnetRpcUrl: string;
  alchemyMainnetRpcUrl: string;
  alchemyDevnetRpcUrl: string;
  heliusMainnetRpcUrl: string;
  heliusDevnetRpcUrl: string;
  rpcRateLimitPerSecond: number;
  dasRateLimitPerSecond: number;
  challengeRateLimitPerMinute: number;
}

export interface RequestContext {
  requestId: string;
  startedAtMs: number;
}
