export type ProviderName = "alchemy" | "helius" | "tokens";
export type ClusterName = "mainnet" | "devnet";
export type SurfaceName = "rpc" | "das" | "tokens" | "wallet";
export type HttpMethod = "GET" | "POST" | "HEAD";
export type RouteInputMode = "solana-envelope" | "query" | "json-body";
export type RouteKind =
  | "solana-rpc"
  | "solana-das"
  | "tokens-query"
  | "tokens-body"
  | "helius-wallet-query"
  | "helius-wallet-body";
export type RouteAccessMode = "exact" | "siwx";

export interface RouteSpec {
  path: string;
  httpMethod: HttpMethod;
  alternateMethods?: HttpMethod[];
  kind: RouteKind;
  accessMode: RouteAccessMode;
  paymentRequired: boolean;
  provider: ProviderName;
  surface: SurfaceName;
  cluster?: ClusterName;
  method: string;
  description: string;
  inputMode: RouteInputMode;
  inputSchema: Record<string, unknown>;
  inputExample: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  priceUsd?: string;
  authNetworks?: string[];
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
  accessMode: RouteAccessMode;
  paymentRequired: boolean;
  priceUsd?: string;
  authNetworks?: string[];
  paymentNetwork?: string;
  paymentAsset?: {
    symbol: string;
    mint: string;
    decimals: number;
  };
  enabled: boolean;
  inputSchema: Record<string, unknown>;
  inputExample?: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  pathParamsSchema?: Record<string, unknown>;
  pathParamsExample?: Record<string, string>;
}

export interface CatalogProviderEntry {
  id: ProviderName;
  label: string;
  routeCount: number;
  href: string;
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
  facilitatorWalletBase58?: string;
  internalSettlementSecret?: string;
  payToWallet: string;
  mainnetUsdcMint: string;
  devnetUsdcMint: string;
  mainnetPaymentNetwork: `${string}:${string}`;
  devnetPaymentNetwork: `${string}:${string}`;
  paymentAssetSymbol: string;
  paymentAssetDecimals: number;
  solanaMainnetRpcUrl: string;
  solanaDevnetRpcUrl: string;
  alchemyMainnetRpcUrl: string;
  alchemyDevnetRpcUrl: string;
  heliusMainnetRpcUrl: string;
  heliusDevnetRpcUrl: string;
  heliusApiKey: string;
  heliusWalletApiBaseUrl: string;
  tokensApiBaseUrl: string;
  tokensApiKey: string;
  rpcRateLimitPerSecond: number;
  dasRateLimitPerSecond: number;
  tokensRateLimitPerMinute: number;
  challengeRateLimitPerMinute: number;
  upstashRedisRestUrl: string;
  upstashRedisRestToken: string;
}
