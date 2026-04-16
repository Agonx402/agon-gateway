import { SOLANA_DEVNET, SOLANA_MAINNET } from "@x402/extensions/sign-in-with-x";
import type { GatewayConfig, RouteSpec } from "./types";

const TOKENS_RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_SEARCH_LIMIT = 50;
const MAX_MARKET_SNAPSHOT_BATCH = 250;
const MAX_VARIANT_MARKETS_BATCH = 50;
const MAX_VARIANT_TOP_MARKETS_LIMIT = 100;
const MAX_OFFSET_LIMIT = 10_000;
const MAX_TICKERS_LIMIT = 50;
const MAX_MARKETS_LIMIT = 50;
const ALLOWED_INCLUDE_VALUES = ["profile", "risk", "ohlcv", "markets"] as const;
const ALLOWED_INTERVAL_VALUES = ["1m", "5m", "15m", "1H", "4H", "1D", "1W"] as const;
const ALLOWED_VARIANT_KINDS = [
  "native",
  "wrapped",
  "bridged",
  "etf",
  "yield",
  "leveraged",
  "basket",
  "lst",
  "stablecoin",
  "tokenized_equity",
] as const;
const ALLOWED_LIQUIDITY_TIERS = ["tier1", "tier2", "tier3"] as const;
const ALLOWED_TRUST_TIERS = ["tier1", "tier2", "tier3", "experimental"] as const;
const ALLOWED_CURATED_LISTS = ["all", "majors", "lsts", "currencies", "rwas", "etfs", "metals", "stocks"] as const;
const ALLOWED_GROUP_BY = ["asset", "mint"] as const;

const ASSET_ID_PATH_PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["assetId"],
  properties: {
    assetId: {
      type: "string",
      description: "Canonical Tokens asset id (for example `solana`) or a singleton `solana-<mint>` id.",
    },
  },
} satisfies Record<string, unknown>;

function createOutputSchema() {
  return {
    type: "object",
    additionalProperties: true,
    properties: {
      ok: { type: "boolean" },
      provider: { type: "string" },
      surface: { type: "string" },
      method: { type: "string" },
      priceUsd: { type: "string" },
      result: {},
    },
  };
}

function createQuerySchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function buildTokensQueryRoute(
  config: GatewayConfig,
  options: {
    path: string;
    upstreamPath: string;
    method: string;
    description: string;
    inputSchema: Record<string, unknown>;
    inputExample?: Record<string, unknown>;
    pathParamsSchema?: Record<string, unknown>;
    pathParamsExample?: Record<string, string>;
    requiresUpstreamAuth?: boolean;
  },
): RouteSpec {
  return {
    path: options.path,
    httpMethod: "GET",
    kind: "tokens-query",
    accessMode: "siwx",
    paymentRequired: false,
    provider: "tokens",
    surface: "tokens",
    method: options.method,
    description: options.description,
    inputMode: "query",
    inputSchema: options.inputSchema,
    inputExample: options.inputExample ?? {},
    outputSchema: createOutputSchema(),
    authNetworks: [SOLANA_MAINNET, SOLANA_DEVNET],
    upstreamPath: options.upstreamPath,
    requiresUpstreamAuth: options.requiresUpstreamAuth ?? true,
    rateLimitScope: "tokens",
    rateLimitLimit: config.tokensRateLimitPerMinute,
    rateLimitWindowMs: TOKENS_RATE_LIMIT_WINDOW_MS,
    pathParamsSchema: options.pathParamsSchema,
    pathParamsExample: options.pathParamsExample,
  };
}

function buildTokensBodyRoute(
  config: GatewayConfig,
  options: {
    path: string;
    upstreamPath: string;
    method: string;
    description: string;
    inputSchema: Record<string, unknown>;
    inputExample: Record<string, unknown>;
  },
): RouteSpec {
  return {
    path: options.path,
    httpMethod: "POST",
    kind: "tokens-body",
    accessMode: "siwx",
    paymentRequired: false,
    provider: "tokens",
    surface: "tokens",
    method: options.method,
    description: options.description,
    inputMode: "json-body",
    inputSchema: options.inputSchema,
    inputExample: options.inputExample,
    outputSchema: createOutputSchema(),
    authNetworks: [SOLANA_MAINNET, SOLANA_DEVNET],
    upstreamPath: options.upstreamPath,
    requiresUpstreamAuth: true,
    rateLimitScope: "tokens",
    rateLimitLimit: config.tokensRateLimitPerMinute,
    rateLimitWindowMs: TOKENS_RATE_LIMIT_WINDOW_MS,
  };
}

export function buildTokensRouteCatalog(config: GatewayConfig): RouteSpec[] {
  return [
    buildTokensQueryRoute(config, {
      path: "/v1/x402/tokens/health",
      upstreamPath: "/v1/health",
      method: "health",
      description: "Proxy the Tokens API v1 health check.",
      inputSchema: createQuerySchema({}),
      requiresUpstreamAuth: false,
    }),
    buildTokensQueryRoute(config, {
      path: "/v1/x402/tokens/assets/search",
      upstreamPath: "/v1/assets/search",
      method: "search",
      description: "Search canonical assets in Tokens API.",
      inputSchema: createQuerySchema(
        {
          q: { type: "string", description: "Search text." },
          limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_LIMIT },
          category: { type: "string", description: "Optional asset category filter." },
        },
        ["q"],
      ),
      inputExample: { q: "solana", limit: 5 },
    }),
    buildTokensQueryRoute(config, {
      path: "/v1/x402/tokens/assets/resolve",
      upstreamPath: "/v1/assets/resolve",
      method: "resolve",
      description: "Resolve an alias or Solana mint to a canonical Tokens asset id.",
      inputSchema: createQuerySchema({
        ref: { type: "string", description: "Canonical asset id, alias, or identifier." },
        mint: { type: "string", description: "Solana mint address." },
      }),
      inputExample: { ref: "solana" },
    }),
    buildTokensQueryRoute(config, {
      path: "/v1/x402/tokens/assets/curated",
      upstreamPath: "/v1/assets/curated",
      method: "curated",
      description: "Return a curated asset list from Tokens API.",
      inputSchema: createQuerySchema(
        {
          list: { type: "string", enum: [...ALLOWED_CURATED_LISTS] },
          groupBy: { type: "string", enum: [...ALLOWED_GROUP_BY] },
        },
        ["list"],
      ),
      inputExample: { list: "majors", groupBy: "asset" },
    }),
    buildTokensBodyRoute(config, {
      path: "/v1/x402/tokens/assets/market-snapshots",
      upstreamPath: "/v1/assets/market-snapshots",
      method: "marketSnapshots",
      description: "Batch lookup cached market snapshots for Solana mints.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mints: {
            type: "array",
            items: { type: "string" },
            maxItems: MAX_MARKET_SNAPSHOT_BATCH,
          },
          addresses: {
            type: "array",
            items: { type: "string" },
            maxItems: MAX_MARKET_SNAPSHOT_BATCH,
          },
        },
      },
      inputExample: {
        mints: ["So11111111111111111111111111111111111111112"],
      },
    }),
    buildTokensQueryRoute(config, {
      path: "/v1/x402/tokens/assets/variant-markets",
      upstreamPath: "/v1/assets/variant-markets",
      method: "variantMarkets",
      description: "Batch lookup cached per-mint variant market snapshots.",
      inputSchema: createQuerySchema({
        mints: { type: "string", description: "Comma-separated Solana mint addresses (max 50)." },
        addresses: { type: "string", description: "Comma-separated Solana mint addresses (max 50)." },
      }),
      inputExample: {
        mints: "So11111111111111111111111111111111111111112,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      },
    }),
    buildTokensQueryRoute(config, {
      path: "/v1/x402/tokens/assets/risk-summary",
      upstreamPath: "/v1/assets/risk-summary",
      method: "riskSummaryByMint",
      description: "Return a quick market-based risk summary for a Solana mint.",
      inputSchema: createQuerySchema(
        {
          mint: { type: "string", description: "Solana mint address." },
        },
        ["mint"],
      ),
      inputExample: { mint: "So11111111111111111111111111111111111111112" },
    }),
    buildTokensQueryRoute(config, {
      path: "/v1/x402/tokens/assets/:assetId",
      upstreamPath: "/v1/assets/:assetId",
      method: "assetDetail",
      description: "Fetch a canonical Tokens asset and optional include blocks.",
      inputSchema: createQuerySchema({
        include: {
          type: "string",
          description: "Comma-separated include list: profile,risk,ohlcv,markets.",
        },
        mint: { type: "string", description: "Optional variant mint used for include computations." },
        variantsMode: { type: "string", enum: ["all"] },
        ohlcvInterval: { type: "string", enum: [...ALLOWED_INTERVAL_VALUES] },
        ohlcvFrom: { type: "integer", minimum: 0 },
        ohlcvTo: { type: "integer", minimum: 0 },
        marketsOffset: { type: "integer", minimum: 0 },
        marketsLimit: { type: "integer", minimum: 1, maximum: MAX_MARKETS_LIMIT },
      }),
      inputExample: { include: "profile,risk", marketsLimit: 5 },
      pathParamsSchema: ASSET_ID_PATH_PARAMS_SCHEMA,
      pathParamsExample: { assetId: "solana" },
    }),
    buildTokensQueryRoute(config, {
      path: "/v1/x402/tokens/assets/:assetId/variants",
      upstreamPath: "/v1/assets/:assetId/variants",
      method: "variants",
      description: "List canonical asset variants, optionally filtered.",
      inputSchema: createQuerySchema({
        kind: { type: "string", enum: [...ALLOWED_VARIANT_KINDS] },
        liquidityTier: { type: "string", enum: [...ALLOWED_LIQUIDITY_TIERS] },
        trustTier: { type: "string", enum: [...ALLOWED_TRUST_TIERS] },
        mint: { type: "string" },
        variantsMode: { type: "string", enum: ["all"] },
      }),
      inputExample: { liquidityTier: "tier1" },
      pathParamsSchema: ASSET_ID_PATH_PARAMS_SCHEMA,
      pathParamsExample: { assetId: "solana" },
    }),
    buildTokensQueryRoute(config, {
      path: "/v1/x402/tokens/assets/:assetId/variant-top-markets",
      upstreamPath: "/v1/assets/:assetId/variant-top-markets",
      method: "variantTopMarkets",
      description: "Return the top DEX market for each asset variant.",
      inputSchema: createQuerySchema({
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: MAX_VARIANT_TOP_MARKETS_LIMIT },
        variantsMode: { type: "string", enum: ["all"] },
      }),
      inputExample: { limit: 10 },
      pathParamsSchema: ASSET_ID_PATH_PARAMS_SCHEMA,
      pathParamsExample: { assetId: "solana" },
    }),
    buildTokensQueryRoute(config, {
      path: "/v1/x402/tokens/assets/:assetId/variant-market",
      upstreamPath: "/v1/assets/:assetId/variant-market",
      method: "variantMarket",
      description: "Fetch the cached variant-market snapshot for a single mint of the asset.",
      inputSchema: createQuerySchema({
        mint: { type: "string" },
      }),
      inputExample: {},
      pathParamsSchema: ASSET_ID_PATH_PARAMS_SCHEMA,
      pathParamsExample: { assetId: "solana" },
    }),
    buildTokensQueryRoute(config, {
      path: "/v1/x402/tokens/assets/:assetId/markets",
      upstreamPath: "/v1/assets/:assetId/markets",
      method: "markets",
      description: "List cached DEX markets for one mint of the asset.",
      inputSchema: createQuerySchema({
        mint: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: MAX_MARKETS_LIMIT },
      }),
      inputExample: { limit: 10 },
      pathParamsSchema: ASSET_ID_PATH_PARAMS_SCHEMA,
      pathParamsExample: { assetId: "solana" },
    }),
    buildTokensQueryRoute(config, {
      path: "/v1/x402/tokens/assets/:assetId/ohlcv",
      upstreamPath: "/v1/assets/:assetId/ohlcv",
      method: "ohlcv",
      description: "Return OHLCV candles for a specific mint variant.",
      inputSchema: createQuerySchema({
        mint: { type: "string" },
        interval: { type: "string", enum: [...ALLOWED_INTERVAL_VALUES] },
        from: { type: "integer", minimum: 0 },
        to: { type: "integer", minimum: 0 },
      }),
      inputExample: { interval: "1D" },
      pathParamsSchema: ASSET_ID_PATH_PARAMS_SCHEMA,
      pathParamsExample: { assetId: "solana" },
    }),
    buildTokensQueryRoute(config, {
      path: "/v1/x402/tokens/assets/:assetId/price-chart",
      upstreamPath: "/v1/assets/:assetId/price-chart",
      method: "priceChart",
      description: "Return canonical price candles, with mint fallback when needed.",
      inputSchema: createQuerySchema({
        mint: { type: "string" },
        interval: { type: "string", enum: [...ALLOWED_INTERVAL_VALUES] },
        from: { type: "integer", minimum: 0 },
        to: { type: "integer", minimum: 0 },
      }),
      inputExample: { interval: "1D" },
      pathParamsSchema: ASSET_ID_PATH_PARAMS_SCHEMA,
      pathParamsExample: { assetId: "solana" },
    }),
    buildTokensQueryRoute(config, {
      path: "/v1/x402/tokens/assets/:assetId/profile",
      upstreamPath: "/v1/assets/:assetId/profile",
      method: "profile",
      description: "Return cached external profile and market stats for an asset.",
      inputSchema: createQuerySchema({}),
      pathParamsSchema: ASSET_ID_PATH_PARAMS_SCHEMA,
      pathParamsExample: { assetId: "solana" },
    }),
    buildTokensQueryRoute(config, {
      path: "/v1/x402/tokens/assets/:assetId/tickers",
      upstreamPath: "/v1/assets/:assetId/tickers",
      method: "tickers",
      description: "Return cached exchange tickers for the canonical asset.",
      inputSchema: createQuerySchema({
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: MAX_TICKERS_LIMIT },
        order: { type: "string" },
      }),
      inputExample: { limit: 10 },
      pathParamsSchema: ASSET_ID_PATH_PARAMS_SCHEMA,
      pathParamsExample: { assetId: "solana" },
    }),
    buildTokensQueryRoute(config, {
      path: "/v1/x402/tokens/assets/:assetId/risk-summary",
      upstreamPath: "/v1/assets/:assetId/risk-summary",
      method: "riskSummary",
      description: "Return a simple risk summary for a mint of the asset.",
      inputSchema: createQuerySchema({
        mint: { type: "string" },
      }),
      inputExample: {},
      pathParamsSchema: ASSET_ID_PATH_PARAMS_SCHEMA,
      pathParamsExample: { assetId: "solana" },
    }),
    buildTokensQueryRoute(config, {
      path: "/v1/x402/tokens/assets/:assetId/risk-details",
      upstreamPath: "/v1/assets/:assetId/risk-details",
      method: "riskDetails",
      description: "Return a detailed risk summary for a mint of the asset.",
      inputSchema: createQuerySchema({
        mint: { type: "string" },
      }),
      inputExample: {},
      pathParamsSchema: ASSET_ID_PATH_PARAMS_SCHEMA,
      pathParamsExample: { assetId: "solana" },
    }),
    buildTokensQueryRoute(config, {
      path: "/v1/x402/tokens/assets/:assetId/description",
      upstreamPath: "/v1/assets/:assetId/description",
      method: "description",
      description: "Return a cached per-mint description summary.",
      inputSchema: createQuerySchema({
        mint: { type: "string" },
      }),
      inputExample: {},
      pathParamsSchema: ASSET_ID_PATH_PARAMS_SCHEMA,
      pathParamsExample: { assetId: "solana" },
    }),
  ];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readOptionalSingleQueryParam(params: URLSearchParams, name: string): string | null | undefined {
  const values = params.getAll(name).map((value) => value.trim()).filter((value) => value.length > 0);
  if (values.length === 0) {
    return undefined;
  }
  if (values.length > 1) {
    return null;
  }
  return values[0];
}

function readRequiredSingleQueryParam(params: URLSearchParams, name: string): string | null {
  const value = readOptionalSingleQueryParam(params, name);
  if (value === undefined) {
    return null;
  }
  return value;
}

function validateIntegerQueryParam(
  params: URLSearchParams,
  name: string,
  min: number,
  max: number,
): string | null {
  const raw = readOptionalSingleQueryParam(params, name);
  if (raw === undefined) {
    return null;
  }
  if (raw === null) {
    return `${name} must be provided at most once.`;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return `${name} must be an integer between ${min} and ${max}.`;
  }

  return null;
}

function validateUnixTimeRange(params: URLSearchParams, fromField: string, toField: string): string | null {
  const fromError = validateIntegerQueryParam(params, fromField, 0, 4_102_444_800);
  if (fromError) {
    return fromError;
  }
  const toError = validateIntegerQueryParam(params, toField, 0, 4_102_444_800);
  if (toError) {
    return toError;
  }

  const from = readOptionalSingleQueryParam(params, fromField);
  const to = readOptionalSingleQueryParam(params, toField);
  if (typeof from === "string" && typeof to === "string" && Number(from) > Number(to)) {
    return `${fromField} must be less than or equal to ${toField}.`;
  }

  return null;
}

function validateEnumQueryParam(
  params: URLSearchParams,
  name: string,
  allowedValues: readonly string[],
): string | null {
  const raw = readOptionalSingleQueryParam(params, name);
  if (raw === undefined) {
    return null;
  }
  if (raw === null) {
    return `${name} must be provided at most once.`;
  }
  if (!allowedValues.includes(raw)) {
    return `${name} must be one of: ${allowedValues.join(", ")}.`;
  }
  return null;
}

function splitCommaSeparatedQueryValues(params: URLSearchParams, name: string): string[] {
  return params
    .getAll(name)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function validateCommaSeparatedBatch(params: URLSearchParams, fields: string[], maxItems: number): string | null {
  const values = fields.flatMap((field) => splitCommaSeparatedQueryValues(params, field));
  if (values.length === 0) {
    return `Provide at least one of ${fields.join(" or ")}.`;
  }
  if (values.length > maxItems) {
    return `${fields.join(" / ")} supports at most ${maxItems} values per request.`;
  }
  if (values.some((value) => value.length === 0)) {
    return `${fields.join(" / ")} cannot contain empty values.`;
  }
  return null;
}

function validateOptionalMintQuery(params: URLSearchParams, name = "mint"): string | null {
  const mint = readOptionalSingleQueryParam(params, name);
  if (mint === undefined) {
    return null;
  }
  if (mint === null) {
    return `${name} must be provided at most once.`;
  }
  return mint.length > 0 ? null : `${name} must be a non-empty string.`;
}

function validateAssetIdPath(pathParams: Record<string, string>): string | null {
  return isNonEmptyString(pathParams.assetId)
    ? null
    : "assetId path param must be a non-empty string.";
}

function validateAssetDetailQuery(params: URLSearchParams): string | null {
  const include = readOptionalSingleQueryParam(params, "include");
  if (include === null) {
    return "include must be provided at most once.";
  }
  if (typeof include === "string") {
    const requested = include.split(",").map((value) => value.trim()).filter(Boolean);
    if (requested.length === 0) {
      return "include must contain at least one include value when provided.";
    }
    if (requested.some((value) => !ALLOWED_INCLUDE_VALUES.includes(value as (typeof ALLOWED_INCLUDE_VALUES)[number]))) {
      return `include values must be drawn from: ${ALLOWED_INCLUDE_VALUES.join(", ")}.`;
    }
  }

  const variantsModeError = validateEnumQueryParam(params, "variantsMode", ["all"]);
  if (variantsModeError) {
    return variantsModeError;
  }

  const ohlcvIntervalError = validateEnumQueryParam(params, "ohlcvInterval", ALLOWED_INTERVAL_VALUES);
  if (ohlcvIntervalError) {
    return ohlcvIntervalError;
  }

  const marketsOffsetError = validateIntegerQueryParam(params, "marketsOffset", 0, MAX_OFFSET_LIMIT);
  if (marketsOffsetError) {
    return marketsOffsetError;
  }

  const marketsLimitError = validateIntegerQueryParam(params, "marketsLimit", 1, MAX_MARKETS_LIMIT);
  if (marketsLimitError) {
    return marketsLimitError;
  }

  const timeRangeError = validateUnixTimeRange(params, "ohlcvFrom", "ohlcvTo");
  if (timeRangeError) {
    return timeRangeError;
  }

  return validateOptionalMintQuery(params);
}

function validateOffsetAndLimit(params: URLSearchParams, maxLimit: number): string | null {
  const offsetError = validateIntegerQueryParam(params, "offset", 0, MAX_OFFSET_LIMIT);
  if (offsetError) {
    return offsetError;
  }

  return validateIntegerQueryParam(params, "limit", 1, maxLimit);
}

function validateIntervalQuery(params: URLSearchParams): string | null {
  const intervalError = validateEnumQueryParam(params, "interval", ALLOWED_INTERVAL_VALUES);
  if (intervalError) {
    return intervalError;
  }

  return validateUnixTimeRange(params, "from", "to");
}

export function validateTokensRouteParams(
  route: RouteSpec,
  params: unknown,
  pathParams: Record<string, string>,
): string | null {
  if (route.kind === "tokens-body") {
    if (!isPlainObject(params)) {
      return "Tokens POST routes require a JSON object body.";
    }

    if (route.method !== "marketSnapshots") {
      return "Unsupported Tokens POST route.";
    }

    const mints = Array.isArray(params.mints) ? params.mints : [];
    const addresses = Array.isArray(params.addresses) ? params.addresses : [];
    const values = [...mints, ...addresses];
    if (values.length === 0) {
      return "marketSnapshots requires a non-empty mints or addresses array.";
    }
    if (values.length > MAX_MARKET_SNAPSHOT_BATCH) {
      return `marketSnapshots accepts at most ${MAX_MARKET_SNAPSHOT_BATCH} ids per request.`;
    }
    if (
      (params.mints !== undefined && (!Array.isArray(params.mints) || mints.some((value) => !isNonEmptyString(value))))
      || (params.addresses !== undefined && (!Array.isArray(params.addresses) || addresses.some((value) => !isNonEmptyString(value))))
    ) {
      return "marketSnapshots mints/addresses must be arrays of non-empty strings.";
    }
    return null;
  }

  if (!(params instanceof URLSearchParams)) {
    return "Tokens GET routes require URL query params.";
  }

  if (route.path.includes(":assetId")) {
    const assetIdError = validateAssetIdPath(pathParams);
    if (assetIdError) {
      return assetIdError;
    }
  }

  switch (route.method) {
    case "health":
      return null;

    case "search": {
      const q = readRequiredSingleQueryParam(params, "q");
      if (q === null) {
        return "q is required and must be provided exactly once.";
      }
      if (!isNonEmptyString(q)) {
        return "q must be a non-empty string.";
      }
      const limitError = validateIntegerQueryParam(params, "limit", 1, MAX_SEARCH_LIMIT);
      if (limitError) {
        return limitError;
      }
      const category = readOptionalSingleQueryParam(params, "category");
      if (category === null) {
        return "category must be provided at most once.";
      }
      return null;
    }

    case "resolve": {
      const ref = readOptionalSingleQueryParam(params, "ref");
      const mint = readOptionalSingleQueryParam(params, "mint");
      if (ref === null || mint === null) {
        return "ref and mint must each be provided at most once.";
      }
      const providedCount = Number(typeof ref === "string") + Number(typeof mint === "string");
      if (providedCount !== 1) {
        return "resolve requires exactly one of ref or mint.";
      }
      return null;
    }

    case "curated": {
      const list = readRequiredSingleQueryParam(params, "list");
      if (list === null) {
        return "list is required and must be provided exactly once.";
      }
      if (!ALLOWED_CURATED_LISTS.includes(list as (typeof ALLOWED_CURATED_LISTS)[number])) {
        return `list must be one of: ${ALLOWED_CURATED_LISTS.join(", ")}.`;
      }
      return validateEnumQueryParam(params, "groupBy", ALLOWED_GROUP_BY);
    }

    case "variantMarkets":
      return validateCommaSeparatedBatch(params, ["mints", "addresses"], MAX_VARIANT_MARKETS_BATCH);

    case "riskSummaryByMint": {
      const mint = readRequiredSingleQueryParam(params, "mint");
      if (mint === null) {
        return "mint is required and must be provided exactly once.";
      }
      return validateOptionalMintQuery(params);
    }

    case "assetDetail":
      return validateAssetDetailQuery(params);

    case "variants": {
      const kindError = validateEnumQueryParam(params, "kind", ALLOWED_VARIANT_KINDS);
      if (kindError) {
        return kindError;
      }
      const liquidityTierError = validateEnumQueryParam(params, "liquidityTier", ALLOWED_LIQUIDITY_TIERS);
      if (liquidityTierError) {
        return liquidityTierError;
      }
      const trustTierError = validateEnumQueryParam(params, "trustTier", ALLOWED_TRUST_TIERS);
      if (trustTierError) {
        return trustTierError;
      }
      const variantsModeError = validateEnumQueryParam(params, "variantsMode", ["all"]);
      if (variantsModeError) {
        return variantsModeError;
      }
      return validateOptionalMintQuery(params);
    }

    case "variantTopMarkets": {
      const offsetLimitError = validateOffsetAndLimit(params, MAX_VARIANT_TOP_MARKETS_LIMIT);
      if (offsetLimitError) {
        return offsetLimitError;
      }
      return validateEnumQueryParam(params, "variantsMode", ["all"]);
    }

    case "variantMarket":
      return validateOptionalMintQuery(params);

    case "markets":
      return validateOptionalMintQuery(params) ?? validateOffsetAndLimit(params, MAX_MARKETS_LIMIT);

    case "ohlcv":
    case "priceChart": {
      const mintError = validateOptionalMintQuery(params);
      if (mintError) {
        return mintError;
      }
      return validateIntervalQuery(params);
    }

    case "profile":
      return null;

    case "tickers": {
      const offsetLimitError = validateOffsetAndLimit(params, MAX_TICKERS_LIMIT);
      if (offsetLimitError) {
        return offsetLimitError;
      }
      const order = readOptionalSingleQueryParam(params, "order");
      if (order === null) {
        return "order must be provided at most once.";
      }
      return null;
    }

    case "riskSummary":
    case "riskDetails":
    case "description":
      return validateOptionalMintQuery(params);

    default:
      return "Unsupported Tokens route.";
  }
}
