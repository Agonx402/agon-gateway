import type { ClusterName, GatewayConfig, RouteSpec } from "./types";

// Helius Wallet API pricing, checked against official Helius docs on 2026-04-20:
// - All wallet endpoints cost 100 credits per request.
// - Helius additional-credits rate is $5 / 1,000,000 credits.
// - 100 credits = $0.0005 per call.
const USD_MICRO_UNITS = 1_000_000;
const HELIUS_USD_MICROS_PER_MILLION_CREDITS = 5_000_000;
const HELIUS_WALLET_CREDITS_PER_CALL = 100;
// Flat surcharge added to every paid endpoint to cover transaction fees.
const TX_FEE_SURCHARGE_USD_MICROS = 600;

const MAX_BATCH_IDENTITY_INPUTS = 100;
const MAX_BALANCES_LIMIT = 100;
const MAX_HISTORY_LIMIT = 100;
const MAX_TRANSFERS_LIMIT = 100;
const MAX_PAGE_INDEX = 1_000;

// Rate-limit scope used for Helius Wallet API calls (requests per second).
// Sized conservatively relative to Helius' published per-plan limits.
const WALLET_RATE_LIMIT_WINDOW_MS = 1_000;

const HISTORY_TX_TYPES = [
  "SWAP",
  "TRANSFER",
  "NFT_SALE",
  "NFT_BID",
  "NFT_LISTING",
  "NFT_MINT",
  "NFT_CANCEL_LISTING",
  "TOKEN_MINT",
  "BURN",
  "COMPRESSED_NFT_MINT",
  "COMPRESSED_NFT_TRANSFER",
  "COMPRESSED_NFT_BURN",
  "CREATE_STORE",
  "WHITELIST_CREATOR",
  "ADD_TO_WHITELIST",
  "REMOVE_FROM_WHITELIST",
  "AUCTION_MANAGER_CLAIM_BID",
  "EMPTY_PAYMENT_ACCOUNT",
  "UPDATE_PRIMARY_SALE_METADATA",
  "ADD_TOKEN_TO_VAULT",
  "ACTIVATE_VAULT",
  "INIT_VAULT",
  "INIT_BANK",
  "INIT_STAKE",
  "MERGE_STAKE",
  "SPLIT_STAKE",
  "CREATE_AUCTION_MANAGER",
  "START_AUCTION",
  "CREATE_AUCTION_MANAGER_V2",
  "UPDATE_EXTERNAL_PRICE_ACCOUNT",
  "EXECUTE_TRANSACTION",
] as const;

const HISTORY_TOKEN_ACCOUNTS = ["none", "balanceChanged", "all"] as const;

// SNS/ANS domain names resolve to on-chain addresses (mainnet-only). We accept
// any non-empty, non-whitespace string here and rely on the upstream to return
// 400/404 if it cannot resolve the input. Addresses and domains are intentionally
// not validated structurally by the gateway so that Helius can keep evolving
// the accepted format (.sol, .bonk, .wen, arbitrary ANS TLDs, etc.).
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatUsdMicros(micros: number): string {
  const whole = Math.floor(micros / USD_MICRO_UNITS);
  const fractional = String(micros % USD_MICRO_UNITS).padStart(6, "0").replace(/0+$/, "");
  return fractional.length > 0 ? `${whole}.${fractional}` : `${whole}`;
}

function ceilDiv(numerator: number, denominator: number): number {
  return Math.floor((numerator + denominator - 1) / denominator);
}

export function heliusWalletPriceUsd(): string {
  const micros = ceilDiv(
    HELIUS_WALLET_CREDITS_PER_CALL * HELIUS_USD_MICROS_PER_MILLION_CREDITS,
    1_000_000,
  ) + TX_FEE_SURCHARGE_USD_MICROS;
  return formatUsdMicros(micros);
}

function createOutputSchema() {
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

const WALLET_PATH_PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["wallet"],
  properties: {
    wallet: {
      type: "string",
      description:
        "Solana wallet address (base58), SNS (.sol) domain, or ANS custom TLD (e.g. miester.bonk). Domain resolution is mainnet-only.",
    },
  },
} satisfies Record<string, unknown>;

function buildWalletQueryRoute(
  config: GatewayConfig,
  cluster: ClusterName,
  options: {
    path: string;
    upstreamPath: string;
    method: string;
    description: string;
    inputSchema: Record<string, unknown>;
    inputExample?: Record<string, unknown>;
    pathParamsSchema?: Record<string, unknown>;
    pathParamsExample?: Record<string, string>;
  },
): RouteSpec {
  return {
    path: options.path,
    httpMethod: "GET",
    alternateMethods: ["HEAD"],
    kind: "helius-wallet-query",
    accessMode: "exact",
    paymentRequired: true,
    provider: "helius",
    surface: "wallet",
    cluster,
    method: options.method,
    description: options.description,
    inputMode: "query",
    inputSchema: options.inputSchema,
    inputExample: options.inputExample ?? {},
    outputSchema: createOutputSchema(),
    priceUsd: heliusWalletPriceUsd(),
    upstreamPath: options.upstreamPath,
    requiresUpstreamAuth: true,
    rateLimitScope: `helius:${cluster}:wallet`,
    rateLimitLimit: config.dasRateLimitPerSecond,
    rateLimitWindowMs: WALLET_RATE_LIMIT_WINDOW_MS,
    pathParamsSchema: options.pathParamsSchema,
    pathParamsExample: options.pathParamsExample,
  };
}

function buildWalletBodyRoute(
  config: GatewayConfig,
  cluster: ClusterName,
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
    alternateMethods: ["HEAD"],
    kind: "helius-wallet-body",
    accessMode: "exact",
    paymentRequired: true,
    provider: "helius",
    surface: "wallet",
    cluster,
    method: options.method,
    description: options.description,
    inputMode: "json-body",
    inputSchema: options.inputSchema,
    inputExample: options.inputExample,
    outputSchema: createOutputSchema(),
    priceUsd: heliusWalletPriceUsd(),
    upstreamPath: options.upstreamPath,
    requiresUpstreamAuth: true,
    rateLimitScope: `helius:${cluster}:wallet`,
    rateLimitLimit: config.dasRateLimitPerSecond,
    rateLimitWindowMs: WALLET_RATE_LIMIT_WINDOW_MS,
  };
}

export function buildHeliusWalletRouteCatalog(config: GatewayConfig): RouteSpec[] {
  const makeRoutes = (cluster: ClusterName, pathPrefix: string): RouteSpec[] => [
    buildWalletQueryRoute(config, cluster, {
      path: `${pathPrefix}/identity/:wallet`,
      upstreamPath: "/v1/wallet/:wallet/identity",
      method: "identity",
      description:
        cluster === "mainnet"
          ? "Resolve on-chain identity for a Solana wallet address or SNS/ANS domain (mainnet-only)."
          : "Resolve on-chain identity for a Solana wallet address on devnet.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      pathParamsSchema: WALLET_PATH_PARAMS_SCHEMA,
      pathParamsExample: { wallet: "toly.sol" },
    }),
    buildWalletBodyRoute(config, cluster, {
      path: `${pathPrefix}/batch-identity`,
      upstreamPath: "/v1/wallet/batch-identity",
      method: "batchIdentity",
      description:
        "Batch lookup of identity information for up to 100 Solana addresses and/or SNS/ANS domains.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["wallets"],
        properties: {
          wallets: {
            type: "array",
            description:
              "List of Solana addresses or SNS/ANS domains. Up to 100 entries per request.",
            minItems: 1,
            maxItems: MAX_BATCH_IDENTITY_INPUTS,
            items: { type: "string" },
          },
        },
      },
      inputExample: {
        wallets: ["GQUtvPx89ZNCwmvQqFmH59bJcU8fW8siETpaxod7Aydz", "toly.sol"],
      },
    }),
    buildWalletQueryRoute(config, cluster, {
      path: `${pathPrefix}/balances/:wallet`,
      upstreamPath: "/v1/wallet/:wallet/balances",
      method: "balances",
      description:
        "Retrieve SPL token and NFT balances for a Solana wallet, sorted by USD value.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          page: { type: "integer", minimum: 1, maximum: MAX_PAGE_INDEX },
          limit: { type: "integer", minimum: 1, maximum: MAX_BALANCES_LIMIT },
          showZeroBalance: { type: "boolean" },
          showNative: { type: "boolean" },
          showNfts: { type: "boolean" },
        },
      },
      inputExample: { limit: 25, showNative: true },
      pathParamsSchema: WALLET_PATH_PARAMS_SCHEMA,
      pathParamsExample: { wallet: "GQUtvPx89ZNCwmvQqFmH59bJcU8fW8siETpaxod7Aydz" },
    }),
    buildWalletQueryRoute(config, cluster, {
      path: `${pathPrefix}/history/:wallet`,
      upstreamPath: "/v1/wallet/:wallet/history",
      method: "history",
      description:
        "Retrieve parsed transaction history with balance changes for a Solana wallet, newest first.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: { type: "integer", minimum: 1, maximum: MAX_HISTORY_LIMIT },
          before: { type: "string" },
          after: { type: "string" },
          type: { type: "string", enum: [...HISTORY_TX_TYPES] },
          tokenAccounts: { type: "string", enum: [...HISTORY_TOKEN_ACCOUNTS] },
        },
      },
      inputExample: { limit: 25, tokenAccounts: "balanceChanged" },
      pathParamsSchema: WALLET_PATH_PARAMS_SCHEMA,
      pathParamsExample: { wallet: "GQUtvPx89ZNCwmvQqFmH59bJcU8fW8siETpaxod7Aydz" },
    }),
    buildWalletQueryRoute(config, cluster, {
      path: `${pathPrefix}/transfers/:wallet`,
      upstreamPath: "/v1/wallet/:wallet/transfers",
      method: "transfers",
      description:
        "Retrieve all token and SOL transfer activity for a Solana wallet with cursor pagination.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: { type: "integer", minimum: 1, maximum: MAX_TRANSFERS_LIMIT },
          cursor: { type: "string" },
        },
      },
      inputExample: { limit: 25 },
      pathParamsSchema: WALLET_PATH_PARAMS_SCHEMA,
      pathParamsExample: { wallet: "GQUtvPx89ZNCwmvQqFmH59bJcU8fW8siETpaxod7Aydz" },
    }),
    buildWalletQueryRoute(config, cluster, {
      path: `${pathPrefix}/funded-by/:wallet`,
      upstreamPath: "/v1/wallet/:wallet/funded-by",
      method: "fundedBy",
      description:
        "Discover the original funding source of a Solana wallet (first incoming SOL transfer).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      pathParamsSchema: WALLET_PATH_PARAMS_SCHEMA,
      pathParamsExample: { wallet: "GQUtvPx89ZNCwmvQqFmH59bJcU8fW8siETpaxod7Aydz" },
    }),
  ];

  return [
    // Legacy mainnet path family (no explicit cluster segment).
    ...makeRoutes("mainnet", "/v1/x402/helius/wallet"),
    // New devnet path family.
    ...makeRoutes("devnet", "/v1/x402/helius/devnet/wallet"),
  ];
}

function readOptionalSingleQueryParam(params: URLSearchParams, name: string): string | null | undefined {
  const values = params.getAll(name).map((value) => value.trim()).filter((value) => value.length > 0);
  if (values.length === 0) return undefined;
  if (values.length > 1) return null;
  return values[0];
}

function validateIntegerQueryParam(
  params: URLSearchParams,
  name: string,
  min: number,
  max: number,
): string | null {
  const raw = readOptionalSingleQueryParam(params, name);
  if (raw === undefined) return null;
  if (raw === null) return `${name} must be provided at most once.`;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return `${name} must be an integer between ${min} and ${max}.`;
  }
  return null;
}

function validateEnumQueryParam(
  params: URLSearchParams,
  name: string,
  allowedValues: readonly string[],
): string | null {
  const raw = readOptionalSingleQueryParam(params, name);
  if (raw === undefined) return null;
  if (raw === null) return `${name} must be provided at most once.`;
  if (!allowedValues.includes(raw)) {
    return `${name} must be one of: ${allowedValues.join(", ")}.`;
  }
  return null;
}

function validateOptionalBooleanQueryParam(
  params: URLSearchParams,
  name: string,
): string | null {
  const raw = readOptionalSingleQueryParam(params, name);
  if (raw === undefined) return null;
  if (raw === null) return `${name} must be provided at most once.`;
  if (raw !== "true" && raw !== "false") {
    return `${name} must be either "true" or "false".`;
  }
  return null;
}

function validateOptionalStringQueryParam(
  params: URLSearchParams,
  name: string,
  maxLength = 200,
): string | null {
  const raw = readOptionalSingleQueryParam(params, name);
  if (raw === undefined) return null;
  if (raw === null) return `${name} must be provided at most once.`;
  if (raw.length === 0 || raw.length > maxLength) {
    return `${name} must be a non-empty string up to ${maxLength} characters.`;
  }
  return null;
}

function validateWalletPath(pathParams: Record<string, string>): string | null {
  return isNonEmptyString(pathParams.wallet)
    ? null
    : "wallet path param must be a non-empty string.";
}

export function validateHeliusWalletRouteParams(
  route: RouteSpec,
  params: unknown,
  pathParams: Record<string, string>,
): string | null {
  if (route.kind === "helius-wallet-body") {
    if (!isPlainObject(params)) {
      return "Helius Wallet POST routes require a JSON object body.";
    }

    if (route.method !== "batchIdentity") {
      return "Unsupported Helius Wallet POST route.";
    }

    const wallets = (params as Record<string, unknown>).wallets;
    if (!Array.isArray(wallets) || wallets.length === 0) {
      return "batchIdentity requires a non-empty wallets array.";
    }
    if (wallets.length > MAX_BATCH_IDENTITY_INPUTS) {
      return `batchIdentity accepts at most ${MAX_BATCH_IDENTITY_INPUTS} wallet entries per request.`;
    }
    if (wallets.some((value) => !isNonEmptyString(value))) {
      return "batchIdentity wallets must be non-empty strings.";
    }
    return null;
  }

  if (!(params instanceof URLSearchParams)) {
    return "Helius Wallet GET routes require URL query params.";
  }

  if (route.path.includes(":wallet")) {
    const walletError = validateWalletPath(pathParams);
    if (walletError) return walletError;
  }

  switch (route.method) {
    case "identity":
    case "fundedBy":
      return null;

    case "balances": {
      const pageError = validateIntegerQueryParam(params, "page", 1, MAX_PAGE_INDEX);
      if (pageError) return pageError;
      const limitError = validateIntegerQueryParam(params, "limit", 1, MAX_BALANCES_LIMIT);
      if (limitError) return limitError;
      return (
        validateOptionalBooleanQueryParam(params, "showZeroBalance")
        ?? validateOptionalBooleanQueryParam(params, "showNative")
        ?? validateOptionalBooleanQueryParam(params, "showNfts")
      );
    }

    case "history": {
      const limitError = validateIntegerQueryParam(params, "limit", 1, MAX_HISTORY_LIMIT);
      if (limitError) return limitError;
      const typeError = validateEnumQueryParam(params, "type", HISTORY_TX_TYPES);
      if (typeError) return typeError;
      const tokenAccountsError = validateEnumQueryParam(params, "tokenAccounts", HISTORY_TOKEN_ACCOUNTS);
      if (tokenAccountsError) return tokenAccountsError;
      const beforeError = validateOptionalStringQueryParam(params, "before");
      if (beforeError) return beforeError;
      return validateOptionalStringQueryParam(params, "after");
    }

    case "transfers": {
      const limitError = validateIntegerQueryParam(params, "limit", 1, MAX_TRANSFERS_LIMIT);
      if (limitError) return limitError;
      return validateOptionalStringQueryParam(params, "cursor");
    }

    default:
      return "Unsupported Helius Wallet route.";
  }
}
