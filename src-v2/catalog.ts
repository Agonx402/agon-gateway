import type {
  CatalogRouteEntry,
  ClusterName,
  GatewayConfig,
  ProviderName,
  RouteSpec,
  SurfaceName,
} from "./types.js";

const CLUSTERS: ClusterName[] = ["mainnet", "devnet"];
const PROVIDERS: ProviderName[] = ["alchemy", "helius"];

const RPC_METHODS: Array<{ method: string; description: string }> = [
  { method: "getBalance", description: "Fetch the lamport balance for an account." },
  { method: "getAccountInfo", description: "Fetch account metadata and raw account data." },
  { method: "getTransaction", description: "Fetch a confirmed transaction by signature." },
  { method: "getSignaturesForAddress", description: "List recent transaction signatures for an address." },
  { method: "getTokenAccountsByOwner", description: "List token accounts owned by an address." },
  { method: "getProgramAccounts", description: "Query accounts owned by a program." }
];

const DAS_METHODS: Array<{ method: string; description: string }> = [
  { method: "getAsset", description: "Fetch a single asset by id." },
  { method: "getAssetsByOwner", description: "Fetch digital assets owned by a wallet." },
  { method: "searchAssets", description: "Search digital assets with DAS filters." }
];

function buildInputSchema(surface: SurfaceName) {
  if (surface === "rpc") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["params"],
      properties: {
        params: {
          type: "array",
          description: "Positional JSON-RPC params passed directly to the upstream provider."
        }
      }
    };
  }

  return {
    type: "object",
    additionalProperties: false,
    required: ["params"],
    properties: {
      params: {
        type: "object",
        description: "Named DAS params passed directly to the upstream provider."
      }
    }
  };
}

function buildOutputSchema() {
  return {
    type: "object",
    additionalProperties: true,
    properties: {
      ok: { type: "boolean" },
      provider: { type: "string" },
      cluster: { type: "string" },
      surface: { type: "string" },
      method: { type: "string" },
      priceUsd: { type: "string" },
      result: {}
    }
  };
}

function buildRouteSpec(
  cluster: ClusterName,
  provider: ProviderName,
  surface: SurfaceName,
  method: string,
  description: string
): RouteSpec {
  return {
    path: `/v1/x402/solana/${cluster}/${provider}/${surface}/${method}`,
    cluster,
    provider,
    surface,
    method,
    description,
    paramsShape: surface === "rpc" ? "array" : "object",
    inputSchema: buildInputSchema(surface),
    outputSchema: buildOutputSchema()
  };
}

export function buildRouteCatalog(): RouteSpec[] {
  const routes: RouteSpec[] = [];

  for (const cluster of CLUSTERS) {
    for (const provider of PROVIDERS) {
      for (const rpc of RPC_METHODS) {
        routes.push(buildRouteSpec(cluster, provider, "rpc", rpc.method, rpc.description));
      }

      for (const das of DAS_METHODS) {
        routes.push(buildRouteSpec(cluster, provider, "das", das.method, das.description));
      }
    }
  }

  return routes;
}

export function buildCatalogEntries(config: GatewayConfig, routes: RouteSpec[]): CatalogRouteEntry[] {
  return routes.map((route) => ({
    path: route.path,
    cluster: route.cluster,
    provider: route.provider,
    surface: route.surface,
    method: route.method,
    description: route.description,
    priceUsd: config.priceUsd,
    paymentNetwork: config.paymentNetwork,
    paymentAsset: {
      symbol: config.paymentAssetSymbol,
      mint: config.usdcMint,
      decimals: config.paymentAssetDecimals
    },
    enabled: true,
    inputSchema: route.inputSchema,
    outputSchema: route.outputSchema
  }));
}

export function routeCatalogMap(routes: RouteSpec[]): Map<string, RouteSpec> {
  return new Map(routes.map((route) => [route.path, route]));
}