export type ProviderName = "alchemy" | "helius" | "tokens";
export type ClusterName = "mainnet" | "devnet";
export type SurfaceName = "rpc" | "das" | "tokens";
export type HttpMethod = "GET" | "POST";
export type RouteInputMode = "solana-envelope" | "query" | "json-body";
export type RouteKind = "solana-rpc" | "solana-das" | "tokens-query" | "tokens-body";

export interface RouteSpec {
  path: string;
  httpMethod: HttpMethod;
  kind: RouteKind;
  provider: ProviderName;
  surface: SurfaceName;
  cluster?: ClusterName;
  method: string;
  description: string;
  inputMode: RouteInputMode;
  inputSchema: Record<string, unknown>;
  inputExample: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  priceUsd: string;
  upstreamPath: string;
  requiresUpstreamAuth: boolean;
  rateLimitScope: string;
  rateLimitLimit: number;
  rateLimitWindowMs: number;
  pathParamsSchema?: Record<string, unknown>;
  pathParamsExample?: Record<string, string>;
}

export interface ResolvedRoute {
  route: RouteSpec;
  pathParams: Record<string, string>;
}

export interface CatalogRouteEntry {
  path: string;
  httpMethod: HttpMethod;
  cluster?: ClusterName;
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
  pathParamsSchema?: Record<string, unknown>;
}

export interface CatalogProviderEntry {
  id: ProviderName;
  label: string;
  routeCount: number;
  href: string;
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
  cdpApiKeyId: string;
  cdpApiKeySecret: string;
  facilitatorWalletBase58?: string;
  internalSettlementSecret?: string;
  payToWallet: string;
  usdcMint: string;
  priceUsd: string;
  priceAtomic: bigint;
  tokensPriceUsd: string;
  tokensPriceAtomic: bigint;
  paymentNetwork: string;
  paymentAssetSymbol: string;
  paymentAssetDecimals: number;
  solanaMainnetRpcUrl: string;
  alchemyMainnetRpcUrl: string;
  alchemyDevnetRpcUrl: string;
  heliusMainnetRpcUrl: string;
  heliusDevnetRpcUrl: string;
  tokensApiBaseUrl: string;
  tokensApiKey: string;
  rpcRateLimitPerSecond: number;
  dasRateLimitPerSecond: number;
  tokensRateLimitPerMinute: number;
  challengeRateLimitPerMinute: number;
  upstashRedisRestUrl: string;
  upstashRedisRestToken: string;
}

export interface RequestContext {
  requestId: string;
  startedAtMs: number;
}
