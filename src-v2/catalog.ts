import { buildTokensRouteCatalog, validateTokensRouteParams } from "./tokens-routes";
import type {
  CatalogRouteEntry,
  ClusterName,
  GatewayConfig,
  HttpMethod,
  ProviderName,
  ResolvedRoute,
  RouteSpec,
  SurfaceName,
} from "./types";

const CLUSTERS: ClusterName[] = ["mainnet", "devnet"];
const PROVIDERS: Exclude<ProviderName, "tokens">[] = ["alchemy", "helius"];

const RPC_METHODS: Array<{ method: string; description: string }> = [
  { method: "getBalance", description: "Fetch the lamport balance for an account." },
  { method: "getAccountInfo", description: "Fetch account metadata and raw account data." },
  { method: "getTransaction", description: "Fetch a confirmed transaction by signature." },
  { method: "getSignaturesForAddress", description: "List recent transaction signatures for an address." },
  { method: "getTokenAccountsByOwner", description: "List token accounts owned by an address." },
  { method: "getProgramAccounts", description: "Query accounts owned by a program." },
];

const DAS_METHODS: Array<{ method: string; description: string }> = [
  { method: "getAsset", description: "Fetch a single asset by id." },
  { method: "getAssetsByOwner", description: "Fetch digital assets owned by a wallet." },
  { method: "searchAssets", description: "Search digital assets with DAS filters." },
];

const MAX_LIST_LIMIT = 100;
const MAX_PROGRAM_ACCOUNT_FILTERS = 4;
const MAX_DATA_SLICE_BYTES = 256;
const MAX_MEMCMP_BYTES_LENGTH = 128;

function isRouteSupported(cluster: ClusterName, provider: Exclude<ProviderName, "tokens">, surface: SurfaceName): boolean {
  if (provider === "alchemy" && cluster === "devnet" && surface === "das") {
    return false;
  }

  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function validateListLimit(container: Record<string, unknown>, fieldName = "limit"): string | null {
  const value = container[fieldName];
  if (value === undefined) {
    return null;
  }

  if (!isIntegerInRange(value, 1, MAX_LIST_LIMIT)) {
    return `${fieldName} must be an integer between 1 and ${MAX_LIST_LIMIT}.`;
  }

  return null;
}

function validateOptionalPage(container: Record<string, unknown>): string | null {
  const value = container.page;
  if (value === undefined) {
    return null;
  }

  if (!isIntegerInRange(value, 1, 10_000)) {
    return "page must be an integer between 1 and 10000.";
  }

  return null;
}

function validateProgramAccountConfig(config: Record<string, unknown>): string | null {
  const filters = config.filters;
  if (!Array.isArray(filters) || filters.length === 0) {
    return "getProgramAccounts requires at least one filter.";
  }

  if (filters.length > MAX_PROGRAM_ACCOUNT_FILTERS) {
    return `getProgramAccounts supports at most ${MAX_PROGRAM_ACCOUNT_FILTERS} filters.`;
  }

  for (const filter of filters) {
    if (!isPlainObject(filter)) {
      return "Each getProgramAccounts filter must be an object.";
    }

    if ("dataSize" in filter) {
      if (!isIntegerInRange(filter.dataSize, 1, 10_000_000)) {
        return "getProgramAccounts dataSize filters must be positive integers.";
      }
      continue;
    }

    if ("memcmp" in filter) {
      const memcmp = filter.memcmp;
      if (!isPlainObject(memcmp)) {
        return "getProgramAccounts memcmp filters must be objects.";
      }

      if (!isIntegerInRange(memcmp.offset, 0, 10_000_000)) {
        return "getProgramAccounts memcmp.offset must be a non-negative integer.";
      }

      if (!isNonEmptyString(memcmp.bytes) || memcmp.bytes.length > MAX_MEMCMP_BYTES_LENGTH) {
        return `getProgramAccounts memcmp.bytes must be a non-empty string up to ${MAX_MEMCMP_BYTES_LENGTH} characters.`;
      }
      continue;
    }

    return "getProgramAccounts filters must use either dataSize or memcmp.";
  }

  const dataSlice = config.dataSlice;
  if (!isPlainObject(dataSlice)) {
    return "getProgramAccounts requires dataSlice to cap returned account data.";
  }

  if (!isIntegerInRange(dataSlice.offset, 0, 10_000_000)) {
    return "getProgramAccounts dataSlice.offset must be a non-negative integer.";
  }

  if (!isIntegerInRange(dataSlice.length, 0, MAX_DATA_SLICE_BYTES)) {
    return `getProgramAccounts dataSlice.length must be between 0 and ${MAX_DATA_SLICE_BYTES}.`;
  }

  return null;
}

function validateRpcParams(method: string, params: unknown): string | null {
  if (!Array.isArray(params)) {
    return 'RPC routes require body shape: { "params": [...] }.';
  }

  switch (method) {
    case "getBalance":
    case "getAccountInfo":
    case "getTransaction": {
      if (params.length < 1 || params.length > 2) {
        return `${method} expects 1 or 2 params.`;
      }
      if (!isNonEmptyString(params[0])) {
        return `${method} requires the first param to be a non-empty string.`;
      }
      if (params[1] !== undefined && !isPlainObject(params[1])) {
        return `${method} config must be an object when provided.`;
      }

      if (method === "getAccountInfo" && params[1] !== undefined) {
        const config = params[1] as Record<string, unknown>;
        if (config.dataSlice !== undefined) {
          if (!isPlainObject(config.dataSlice)) {
            return "getAccountInfo dataSlice must be an object.";
          }
          if (!isIntegerInRange(config.dataSlice.offset, 0, 10_000_000)) {
            return "getAccountInfo dataSlice.offset must be a non-negative integer.";
          }
          if (!isIntegerInRange(config.dataSlice.length, 0, 1024)) {
            return "getAccountInfo dataSlice.length must be between 0 and 1024.";
          }
        }
      }
      return null;
    }

    case "getSignaturesForAddress": {
      if (params.length < 1 || params.length > 2) {
        return "getSignaturesForAddress expects 1 or 2 params.";
      }
      if (!isNonEmptyString(params[0])) {
        return "getSignaturesForAddress requires the first param to be a non-empty string.";
      }
      if (params[1] !== undefined) {
        if (!isPlainObject(params[1])) {
          return "getSignaturesForAddress options must be an object when provided.";
        }
        return validateListLimit(params[1] as Record<string, unknown>);
      }
      return null;
    }

    case "getTokenAccountsByOwner": {
      if (params.length < 2 || params.length > 3) {
        return "getTokenAccountsByOwner expects 2 or 3 params.";
      }
      if (!isNonEmptyString(params[0])) {
        return "getTokenAccountsByOwner requires the owner address as the first param.";
      }
      if (!isPlainObject(params[1])) {
        return "getTokenAccountsByOwner requires a mint/programId filter object.";
      }
      const filter = params[1] as Record<string, unknown>;
      const hasMint = isNonEmptyString(filter.mint);
      const hasProgramId = isNonEmptyString(filter.programId);
      if ((hasMint && hasProgramId) || (!hasMint && !hasProgramId)) {
        return "getTokenAccountsByOwner filter must specify exactly one of mint or programId.";
      }
      if (params[2] !== undefined && !isPlainObject(params[2])) {
        return "getTokenAccountsByOwner config must be an object when provided.";
      }
      return null;
    }

    case "getProgramAccounts": {
      if (params.length !== 2) {
        return "getProgramAccounts expects exactly 2 params.";
      }
      if (!isNonEmptyString(params[0])) {
        return "getProgramAccounts requires the program id as the first param.";
      }
      if (!isPlainObject(params[1])) {
        return "getProgramAccounts requires a config object as the second param.";
      }
      return validateProgramAccountConfig(params[1] as Record<string, unknown>);
    }

    default:
      return "Unsupported RPC method.";
  }
}

function validateDasParams(method: string, params: unknown): string | null {
  if (!isPlainObject(params)) {
    return 'DAS routes require body shape: { "params": { ... } }.';
  }

  switch (method) {
    case "getAsset":
      return isNonEmptyString(params.id)
        ? null
        : "getAsset requires params.id to be a non-empty string.";

    case "getAssetsByOwner": {
      if (!isNonEmptyString(params.ownerAddress)) {
        return "getAssetsByOwner requires params.ownerAddress to be a non-empty string.";
      }
      return validateListLimit(params);
    }

    case "searchAssets": {
      const limitError = validateListLimit(params);
      if (limitError) {
        return limitError;
      }
      return validateOptionalPage(params);
    }

    default:
      return "Unsupported DAS method.";
  }
}

function buildSolanaInputSchema(surface: Extract<SurfaceName, "rpc" | "das">) {
  if (surface === "rpc") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["params"],
      properties: {
        params: {
          type: "array",
          description: "Positional JSON-RPC params passed directly to the upstream provider.",
        },
      },
    };
  }

  return {
    type: "object",
    additionalProperties: false,
    required: ["params"],
    properties: {
      params: {
        type: "object",
        description: "Named DAS params passed directly to the upstream provider.",
      },
    },
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
      result: {},
    },
  };
}

function buildSolanaRouteSpec(
  config: GatewayConfig,
  cluster: ClusterName,
  provider: Exclude<ProviderName, "tokens">,
  surface: Extract<SurfaceName, "rpc" | "das">,
  method: string,
  description: string,
): RouteSpec {
  return {
    path: `/v1/x402/solana/${cluster}/${provider}/${surface}/${method}`,
    httpMethod: "POST",
    alternateMethods: ["GET", "HEAD"],
    kind: surface === "rpc" ? "solana-rpc" : "solana-das",
    accessMode: "exact",
    paymentRequired: true,
    cluster,
    provider,
    surface,
    method,
    description,
    inputMode: "solana-envelope",
    inputSchema: buildSolanaInputSchema(surface),
    inputExample: {
      params: surface === "rpc" ? [] : {},
    },
    outputSchema: buildOutputSchema(),
    priceUsd: config.priceUsd,
    upstreamPath: "",
    requiresUpstreamAuth: false,
    rateLimitScope: `${provider}:${cluster}:${surface}`,
    rateLimitLimit: surface === "das" ? config.dasRateLimitPerSecond : config.rpcRateLimitPerSecond,
    rateLimitWindowMs: 1_000,
  };
}

export function buildRouteCatalog(config: GatewayConfig): RouteSpec[] {
  const routes: RouteSpec[] = [];

  for (const cluster of CLUSTERS) {
    for (const provider of PROVIDERS) {
      for (const rpc of RPC_METHODS) {
        if (isRouteSupported(cluster, provider, "rpc")) {
          routes.push(buildSolanaRouteSpec(config, cluster, provider, "rpc", rpc.method, rpc.description));
        }
      }

      for (const das of DAS_METHODS) {
        if (isRouteSupported(cluster, provider, "das")) {
          routes.push(buildSolanaRouteSpec(config, cluster, provider, "das", das.method, das.description));
        }
      }
    }
  }

  routes.push(...buildTokensRouteCatalog(config));
  return routes;
}

export function buildCatalogEntries(config: GatewayConfig, routes: RouteSpec[]): CatalogRouteEntry[] {
  return routes.map((route) => ({
    path: route.path,
    httpMethod: route.httpMethod,
    cluster: route.cluster,
    provider: route.provider,
    surface: route.surface,
    method: route.method,
    description: route.description,
    accessMode: route.accessMode,
    paymentRequired: route.paymentRequired,
    ...(route.priceUsd ? { priceUsd: route.priceUsd } : {}),
    ...(route.authNetworks ? { authNetworks: route.authNetworks } : {}),
    ...(route.paymentRequired
      ? {
        paymentNetwork: config.paymentNetwork,
        paymentAsset: {
          symbol: config.paymentAssetSymbol,
          mint: config.usdcMint,
          decimals: config.paymentAssetDecimals,
        },
      }
      : {}),
    enabled: true,
    inputSchema: route.inputSchema,
    outputSchema: route.outputSchema,
    pathParamsSchema: route.pathParamsSchema,
  }));
}

function matchRoutePath(template: string, pathname: string): { score: number; pathParams: Record<string, string> } | null {
  const templateSegments = template.split("/").filter(Boolean);
  const pathSegments = pathname.split("/").filter(Boolean);
  if (templateSegments.length !== pathSegments.length) {
    return null;
  }

  const pathParams: Record<string, string> = {};
  let score = 0;

  for (let index = 0; index < templateSegments.length; index += 1) {
    const templateSegment = templateSegments[index]!;
    const pathSegment = pathSegments[index]!;

    if (templateSegment.startsWith(":")) {
      pathParams[templateSegment.slice(1)] = decodeURIComponent(pathSegment);
      continue;
    }

    if (templateSegment !== pathSegment) {
      return null;
    }

    score += 1;
  }

  return { score, pathParams };
}

export function resolveRoute(routes: RouteSpec[], method: HttpMethod, pathname: string): ResolvedRoute | null {
  let bestMatch: ResolvedRoute | null = null;
  let bestScore = -1;

  for (const route of routes) {
    if (route.httpMethod !== method && !route.alternateMethods?.includes(method)) {
      continue;
    }

    const matched = matchRoutePath(route.path, pathname);
    if (!matched || matched.score < bestScore) {
      continue;
    }

    bestScore = matched.score;
    bestMatch = {
      route,
      pathParams: matched.pathParams,
    };
  }

  return bestMatch;
}

export function resolveRouteByPath(routes: RouteSpec[], pathname: string): ResolvedRoute | null {
  let bestMatch: ResolvedRoute | null = null;
  let bestScore = -1;

  for (const route of routes) {
    const matched = matchRoutePath(route.path, pathname);
    if (!matched || matched.score < bestScore) {
      continue;
    }

    bestScore = matched.score;
    bestMatch = {
      route,
      pathParams: matched.pathParams,
    };
  }

  return bestMatch;
}

export function validateRouteParams(
  route: RouteSpec,
  params: unknown,
  pathParams: Record<string, string>,
): string | null {
  switch (route.kind) {
    case "solana-rpc":
      return validateRpcParams(route.method, params);
    case "solana-das":
      return validateDasParams(route.method, params);
    case "tokens-query":
    case "tokens-body":
      return validateTokensRouteParams(route, params, pathParams);
    default:
      return "Unsupported route kind.";
  }
}
