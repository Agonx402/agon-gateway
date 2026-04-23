import { buildHeliusWalletRouteCatalog, validateHeliusWalletRouteParams } from "./helius-wallet-routes";
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

type SolanaProvider = Exclude<ProviderName, "tokens">;

const CLUSTERS: ClusterName[] = ["mainnet", "devnet"];
const PROVIDERS: SolanaProvider[] = ["alchemy", "helius"];

function routePaymentNetwork(config: GatewayConfig, route: RouteSpec): string {
  return route.cluster === "devnet"
    ? config.devnetPaymentNetwork
    : config.mainnetPaymentNetwork;
}

function routePaymentMint(config: GatewayConfig, route: RouteSpec): string {
  return route.cluster === "devnet"
    ? config.devnetUsdcMint
    : config.mainnetUsdcMint;
}

interface SolanaMethodSpec {
  method: string;
  description: string;
  // Providers that expose this method. Defaults to both when omitted.
  providers?: SolanaProvider[];
}

const RPC_METHODS: SolanaMethodSpec[] = [
  { method: "getBalance", description: "Fetch the lamport balance for an account." },
  { method: "getAccountInfo", description: "Fetch account metadata and raw account data." },
  { method: "getTransaction", description: "Fetch a confirmed transaction by signature." },
  { method: "getSignaturesForAddress", description: "List recent transaction signatures for an address." },
  { method: "getTokenAccountsByOwner", description: "List token accounts owned by an address." },
  { method: "getProgramAccounts", description: "Query accounts owned by a program." },
  {
    method: "getTransactionsForAddress",
    description:
      "Enhanced transaction history with filtering, sorting, and keyset pagination for any address.",
    providers: ["helius"],
  },
];

const DAS_METHODS: SolanaMethodSpec[] = [
  { method: "getAsset", description: "Fetch a single asset by id." },
  { method: "getAssetsByOwner", description: "Fetch digital assets owned by a wallet." },
  { method: "searchAssets", description: "Search digital assets with DAS filters." },
];

// Pricing sources, checked against official provider docs on 2026-04-18:
// - Alchemy Solana PAYG: $0.45 / 1M CU
// - Helius additional credits: $5 / 1M credits
const USD_MICRO_UNITS = 1_000_000;
const ALCHEMY_USD_MICROS_PER_MILLION_CU = 450_000;
const HELIUS_USD_MICROS_PER_MILLION_CREDITS = 5_000_000;
// Flat surcharge added to every paid endpoint to cover transaction fees.
const TX_FEE_SURCHARGE_USD_MICROS = 600;

const ALCHEMY_RPC_CU_BY_METHOD: Record<string, number> = {
  getBalance: 10,
  getAccountInfo: 10,
  getTransaction: 40,
  getSignaturesForAddress: 40,
  getTokenAccountsByOwner: 10,
  getProgramAccounts: 20,
};

const ALCHEMY_DAS_CU_BY_METHOD: Record<string, number> = {
  getAsset: 80,
  getAssetsByOwner: 480,
  searchAssets: 480,
};

const HELIUS_RPC_CREDITS_BY_METHOD: Record<string, number> = {
  getBalance: 1,
  getAccountInfo: 1,
  getTransaction: 1,
  getSignaturesForAddress: 1,
  getTokenAccountsByOwner: 1,
  getProgramAccounts: 10,
  getTransactionsForAddress: 50,
};

const HELIUS_DAS_CREDITS_BY_METHOD: Record<string, number> = {
  getAsset: 10,
  getAssetsByOwner: 10,
  searchAssets: 10,
};

const MAX_LIST_LIMIT = 100;
const MAX_PROGRAM_ACCOUNT_FILTERS = 4;
const MAX_DATA_SLICE_BYTES = 256;
const MAX_MEMCMP_BYTES_LENGTH = 128;

function formatUsdMicros(micros: number): string {
  const whole = Math.floor(micros / USD_MICRO_UNITS);
  const fractional = String(micros % USD_MICRO_UNITS).padStart(6, "0").replace(/0+$/, "");
  return fractional.length > 0 ? `${whole}.${fractional}` : `${whole}`;
}

function ceilDiv(numerator: number, denominator: number): number {
  return Math.floor((numerator + denominator - 1) / denominator);
}

function alchemyPriceUsd(cu: number): string {
  const micros = ceilDiv(cu * ALCHEMY_USD_MICROS_PER_MILLION_CU, 1_000_000)
    + TX_FEE_SURCHARGE_USD_MICROS;
  return formatUsdMicros(micros);
}

function heliusPriceUsd(credits: number): string {
  const micros = ceilDiv(
    credits * HELIUS_USD_MICROS_PER_MILLION_CREDITS,
    1_000_000,
  ) + TX_FEE_SURCHARGE_USD_MICROS;
  return formatUsdMicros(micros);
}

function getSolanaRoutePriceUsd(
  provider: Exclude<ProviderName, "tokens">,
  surface: Extract<SurfaceName, "rpc" | "das">,
  method: string,
): string {
  if (provider === "alchemy") {
    const cu = surface === "rpc"
      ? ALCHEMY_RPC_CU_BY_METHOD[method]
      : ALCHEMY_DAS_CU_BY_METHOD[method];

    if (!cu) {
      throw new Error(`Missing Alchemy price mapping for ${surface}:${method}`);
    }

    return alchemyPriceUsd(cu);
  }

  const credits = surface === "rpc"
    ? HELIUS_RPC_CREDITS_BY_METHOD[method]
    : HELIUS_DAS_CREDITS_BY_METHOD[method];

  if (!credits) {
    throw new Error(`Missing Helius price mapping for ${surface}:${method}`);
  }

  return heliusPriceUsd(credits);
}

function isRouteSupported(cluster: ClusterName, provider: SolanaProvider, surface: SurfaceName): boolean {
  if (provider === "alchemy" && cluster === "devnet" && surface === "das") {
    return false;
  }

  return true;
}

function methodSupportsProvider(spec: SolanaMethodSpec, provider: SolanaProvider): boolean {
  if (!spec.providers) {
    return true;
  }
  return spec.providers.includes(provider);
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

    case "getTransactionsForAddress":
      return validateGetTransactionsForAddressParams(params);

    default:
      return "Unsupported RPC method.";
  }
}

const GTFA_TRANSACTION_DETAILS = ["signatures", "full"] as const;
const GTFA_SORT_ORDERS = ["asc", "desc"] as const;
const GTFA_COMMITMENTS = ["confirmed", "finalized"] as const;
const GTFA_ENCODINGS = ["json", "jsonParsed", "base58", "base64"] as const;
const GTFA_STATUSES = ["succeeded", "failed", "any"] as const;
const GTFA_TOKEN_ACCOUNT_FILTERS = ["none", "balanceChanged", "all"] as const;
const GTFA_MAX_SIGNATURES_LIMIT = 1_000;
const GTFA_MAX_FULL_LIMIT = 100;
const GTFA_MAX_RANGE_COMPARATORS = ["gte", "gt", "lte", "lt"] as const;
const GTFA_TIMESTAMP_COMPARATORS = [...GTFA_MAX_RANGE_COMPARATORS, "eq"] as const;
const GTFA_ALLOWED_FILTER_KEYS = new Set([
  "slot",
  "blockTime",
  "signature",
  "status",
  "tokenAccounts",
]);
const GTFA_ALLOWED_CONFIG_KEYS = new Set([
  "transactionDetails",
  "sortOrder",
  "commitment",
  "minContextSlot",
  "limit",
  "paginationToken",
  "encoding",
  "maxSupportedTransactionVersion",
  // Helius supports `tokenAccounts` at the top level. We also support the
  // legacy `filters.tokenAccounts` shape for backward compatibility.
  "tokenAccounts",
  "filters",
]);

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function validateRangeFilter(
  filter: Record<string, unknown>,
  comparators: readonly string[],
  valueType: "integer" | "string",
  fieldName: string,
): string | null {
  for (const key of Object.keys(filter)) {
    if (!comparators.includes(key)) {
      return `filters.${fieldName}.${key} is not a supported comparator (allowed: ${comparators.join(", ")}).`;
    }
    const value = filter[key];
    if (valueType === "integer") {
      if (!isIntegerInRange(value, 0, Number.MAX_SAFE_INTEGER)) {
        return `filters.${fieldName}.${key} must be a non-negative integer.`;
      }
    } else {
      if (!isNonEmptyString(value) || value.length > 128) {
        return `filters.${fieldName}.${key} must be a non-empty string up to 128 characters.`;
      }
    }
  }
  return null;
}

function validateGetTransactionsForAddressConfig(config: Record<string, unknown>): string | null {
  for (const key of Object.keys(config)) {
    if (!GTFA_ALLOWED_CONFIG_KEYS.has(key)) {
      return `getTransactionsForAddress config.${key} is not a supported field.`;
    }
  }

  const transactionDetails = config.transactionDetails;
  if (transactionDetails !== undefined && !GTFA_TRANSACTION_DETAILS.includes(transactionDetails as (typeof GTFA_TRANSACTION_DETAILS)[number])) {
    return `getTransactionsForAddress transactionDetails must be one of: ${GTFA_TRANSACTION_DETAILS.join(", ")}.`;
  }

  const sortOrder = config.sortOrder;
  if (sortOrder !== undefined && !GTFA_SORT_ORDERS.includes(sortOrder as (typeof GTFA_SORT_ORDERS)[number])) {
    return `getTransactionsForAddress sortOrder must be one of: ${GTFA_SORT_ORDERS.join(", ")}.`;
  }

  const commitment = config.commitment;
  if (commitment !== undefined && !GTFA_COMMITMENTS.includes(commitment as (typeof GTFA_COMMITMENTS)[number])) {
    return `getTransactionsForAddress commitment must be one of: ${GTFA_COMMITMENTS.join(", ")}.`;
  }

  const encoding = config.encoding;
  if (encoding !== undefined && !GTFA_ENCODINGS.includes(encoding as (typeof GTFA_ENCODINGS)[number])) {
    return `getTransactionsForAddress encoding must be one of: ${GTFA_ENCODINGS.join(", ")}.`;
  }

  if (config.minContextSlot !== undefined && !isNonNegativeInteger(config.minContextSlot)) {
    return "getTransactionsForAddress minContextSlot must be a non-negative integer.";
  }

  if (config.maxSupportedTransactionVersion !== undefined && !isNonNegativeInteger(config.maxSupportedTransactionVersion)) {
    return "getTransactionsForAddress maxSupportedTransactionVersion must be a non-negative integer.";
  }

  if (config.paginationToken !== undefined && !isNonEmptyString(config.paginationToken)) {
    return "getTransactionsForAddress paginationToken must be a non-empty string.";
  }

  if (config.limit !== undefined) {
    const isFull = transactionDetails === "full";
    const maxLimit = isFull ? GTFA_MAX_FULL_LIMIT : GTFA_MAX_SIGNATURES_LIMIT;
    if (!isIntegerInRange(config.limit, 1, maxLimit)) {
      return `getTransactionsForAddress limit must be an integer between 1 and ${maxLimit} (transactionDetails=${isFull ? "full" : "signatures"}).`;
    }
  }

  if (
    config.tokenAccounts !== undefined
    && !GTFA_TOKEN_ACCOUNT_FILTERS.includes(config.tokenAccounts as (typeof GTFA_TOKEN_ACCOUNT_FILTERS)[number])
  ) {
    return `getTransactionsForAddress tokenAccounts must be one of: ${GTFA_TOKEN_ACCOUNT_FILTERS.join(", ")}.`;
  }

  if (config.filters !== undefined) {
    if (!isPlainObject(config.filters)) {
      return "getTransactionsForAddress filters must be an object.";
    }

    for (const key of Object.keys(config.filters)) {
      if (!GTFA_ALLOWED_FILTER_KEYS.has(key)) {
        return `getTransactionsForAddress filters.${key} is not a supported filter.`;
      }
    }

    if (config.filters.slot !== undefined) {
      if (!isPlainObject(config.filters.slot)) {
        return "getTransactionsForAddress filters.slot must be an object.";
      }
      const slotError = validateRangeFilter(
        config.filters.slot as Record<string, unknown>,
        GTFA_MAX_RANGE_COMPARATORS,
        "integer",
        "slot",
      );
      if (slotError) return slotError;
    }

    if (config.filters.blockTime !== undefined) {
      if (!isPlainObject(config.filters.blockTime)) {
        return "getTransactionsForAddress filters.blockTime must be an object.";
      }
      const blockTimeError = validateRangeFilter(
        config.filters.blockTime as Record<string, unknown>,
        GTFA_TIMESTAMP_COMPARATORS,
        "integer",
        "blockTime",
      );
      if (blockTimeError) return blockTimeError;
    }

    if (config.filters.signature !== undefined) {
      if (!isPlainObject(config.filters.signature)) {
        return "getTransactionsForAddress filters.signature must be an object.";
      }
      const signatureError = validateRangeFilter(
        config.filters.signature as Record<string, unknown>,
        GTFA_MAX_RANGE_COMPARATORS,
        "string",
        "signature",
      );
      if (signatureError) return signatureError;
    }

    if (
      config.filters.status !== undefined
      && !GTFA_STATUSES.includes(config.filters.status as (typeof GTFA_STATUSES)[number])
    ) {
      return `getTransactionsForAddress filters.status must be one of: ${GTFA_STATUSES.join(", ")}.`;
    }

    if (
      config.filters.tokenAccounts !== undefined
      && !GTFA_TOKEN_ACCOUNT_FILTERS.includes(config.filters.tokenAccounts as (typeof GTFA_TOKEN_ACCOUNT_FILTERS)[number])
    ) {
      return `getTransactionsForAddress filters.tokenAccounts must be one of: ${GTFA_TOKEN_ACCOUNT_FILTERS.join(", ")}.`;
    }
  }

  if (config.tokenAccounts !== undefined && config.filters?.tokenAccounts !== undefined) {
    return "getTransactionsForAddress tokenAccounts must be provided either at top level or in filters.tokenAccounts, not both.";
  }

  return null;
}

function validateGetTransactionsForAddressParams(params: unknown[]): string | null {
  if (params.length < 1 || params.length > 2) {
    return "getTransactionsForAddress expects 1 or 2 params.";
  }
  if (!isNonEmptyString(params[0])) {
    return "getTransactionsForAddress requires the address as the first param.";
  }
  if (params[1] === undefined) {
    return null;
  }
  if (!isPlainObject(params[1])) {
    return "getTransactionsForAddress config must be an object when provided.";
  }
  return validateGetTransactionsForAddressConfig(params[1] as Record<string, unknown>);
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
    priceUsd: getSolanaRoutePriceUsd(provider, surface, method),
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
        if (!methodSupportsProvider(rpc, provider)) continue;
        if (!isRouteSupported(cluster, provider, "rpc")) continue;
        routes.push(buildSolanaRouteSpec(config, cluster, provider, "rpc", rpc.method, rpc.description));
      }

      for (const das of DAS_METHODS) {
        if (!methodSupportsProvider(das, provider)) continue;
        if (!isRouteSupported(cluster, provider, "das")) continue;
        routes.push(buildSolanaRouteSpec(config, cluster, provider, "das", das.method, das.description));
      }
    }
  }

  routes.push(...buildHeliusWalletRouteCatalog(config));
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
        paymentNetwork: routePaymentNetwork(config, route),
        paymentAsset: {
          symbol: config.paymentAssetSymbol,
          mint: routePaymentMint(config, route),
          decimals: config.paymentAssetDecimals,
        },
      }
      : {}),
    enabled: true,
    inputSchema: route.inputSchema,
    ...(route.inputExample && Object.keys(route.inputExample).length > 0
      ? { inputExample: route.inputExample }
      : {}),
    outputSchema: route.outputSchema,
    pathParamsSchema: route.pathParamsSchema,
    ...(route.pathParamsExample ? { pathParamsExample: route.pathParamsExample } : {}),
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
    case "helius-wallet-query":
    case "helius-wallet-body":
      return validateHeliusWalletRouteParams(route, params, pathParams);
    default:
      return "Unsupported route kind.";
  }
}
