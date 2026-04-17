import { createHash, randomUUID } from "node:crypto";
import { createFacilitatorConfig } from "@coinbase/x402";
import {
  HTTPFacilitatorClient,
  type HTTPProcessResult,
  type HTTPResponseInstructions,
  type RouteConfig,
  type RoutesConfig,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/core/server";
import { x402Facilitator } from "@x402/core/facilitator";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  createSIWxRequestHook,
  declareSIWxExtension,
  siwxResourceServerExtension,
} from "@x402/extensions/sign-in-with-x";
import { NextAdapter } from "@x402/next";
import { SOLANA_MAINNET_CAIP2, toFacilitatorSvmSigner } from "@x402/svm";
import { registerExactSvmScheme as registerExactSvmFacilitatorScheme } from "@x402/svm/exact/facilitator";
import { registerExactSvmScheme as registerExactSvmServerScheme } from "@x402/svm/exact/server";
import { NextRequest, NextResponse } from "next/server";
import { buildCatalogEntries, buildRouteCatalog, resolveRoute, resolveRouteByPath, validateRouteParams } from "./catalog";
import { loadConfig } from "./config";
import { loadFacilitatorSigner } from "./facilitator-wallet";
import { HostedGatewayState } from "./hosted-state";
import { logEvent } from "./hosted-logger";
import type {
  CatalogProviderEntry,
  CatalogRouteEntry,
  EventRecord,
  GatewayConfig,
  HttpMethod,
  ResolvedRoute,
  RouteSpec,
} from "./types";
import { forwardToUpstream, UpstreamHttpError } from "./upstream";

interface GatewayRuntime {
  config: GatewayConfig;
  state: HostedGatewayState;
  routes: RouteSpec[];
  catalog: CatalogRouteEntry[];
  httpServer: x402HTTPResourceServer;
}

interface FacilitatorRuntime {
  config: GatewayConfig;
  facilitator: x402Facilitator;
}

interface ParsedRequestBody {
  body: unknown;
  isEmpty: boolean;
}

interface ParsedSolanaQueryParams {
  params: unknown;
  isEmpty: boolean;
}

let runtimePromise: Promise<GatewayRuntime> | null = null;
let facilitatorRuntimePromise: Promise<FacilitatorRuntime> | null = null;

const PROVIDER_LABELS: Record<CatalogRouteEntry["provider"], string> = {
  alchemy: "Alchemy",
  helius: "Helius",
  tokens: "TokensAPI",
};

const ACCESS_CONTROL_ALLOW_HEADERS = [
  "Content-Type",
  "PAYMENT-SIGNATURE",
  "X-PAYMENT",
  "X-PAYMENT-RESPONSE",
  "PAYMENT-RESPONSE",
  "SIGN-IN-WITH-X",
  "Authorization",
].join(", ");

const ACCESS_CONTROL_EXPOSE_HEADERS = [
  "Content-Type",
  "WWW-Authenticate",
  "X-PAYMENT-RESPONSE",
  "PAYMENT-RESPONSE",
].join(", ");

function buildDiscoveryExtension(config: GatewayConfig, route: RouteSpec) {
  const outputExample: Record<string, unknown> = {
    ok: true,
    provider: route.provider,
    cluster: route.cluster,
    surface: route.surface,
    method: route.method,
    result: route.provider === "tokens"
      ? {}
      : route.surface === "rpc"
        ? {}
        : { items: [] },
  };

  if (route.paymentRequired) {
    outputExample.priceUsd = route.priceUsd;
    outputExample.paymentNetwork = config.paymentNetwork;
  }

  const output = {
    example: {
      ...outputExample,
    },
    schema: route.outputSchema,
  };

  if (route.inputMode === "query") {
    return declareDiscoveryExtension({
      input: route.inputExample,
      inputSchema: route.inputSchema,
      pathParams: route.pathParamsExample,
      pathParamsSchema: route.pathParamsSchema,
      output,
    });
  }

  return declareDiscoveryExtension({
    input: route.inputExample,
    inputSchema: route.inputSchema,
    pathParams: route.pathParamsExample,
    pathParamsSchema: route.pathParamsSchema,
    bodyType: "json",
    output,
  });
}

function buildRouteExtensions(config: GatewayConfig, route: RouteSpec) {
  const discovery = buildDiscoveryExtension(config, route);
  if (route.accessMode !== "siwx") {
    return discovery;
  }

  const network = route.authNetworks && route.authNetworks.length === 1
    ? route.authNetworks[0]
    : route.authNetworks;

  return {
    ...discovery,
    ...declareSIWxExtension({
      network,
      statement: "Sign in with your wallet to access TokensAPI through Agon.",
      expirationSeconds: 300,
    }),
  };
}

function buildRoutesConfig(config: GatewayConfig, routes: RouteSpec[]): RoutesConfig {
  const entries: Record<string, RouteConfig> = {};

  for (const route of routes) {
    if (route.accessMode === "exact") {
      if (!route.priceUsd) {
        continue;
      }

      const paymentPrice = route.priceUsd.startsWith("$") ? route.priceUsd : `$${route.priceUsd}`;
      entries[`${route.httpMethod} ${route.path}`] = {
        accepts: {
          scheme: "exact",
          price: paymentPrice,
          network: SOLANA_MAINNET_CAIP2,
          payTo: config.payToWallet,
        },
        description: route.description,
        mimeType: "application/json",
        extensions: buildRouteExtensions(config, route),
      };
      continue;
    }

    entries[`${route.httpMethod} ${route.path}`] = {
      accepts: [],
      description: route.description,
      mimeType: "application/json",
      extensions: buildRouteExtensions(config, route),
    };
  }

  return entries;
}

function paymentHeader(request: NextRequest): string | undefined {
  return request.headers.get("payment-signature")
    ?? request.headers.get("PAYMENT-SIGNATURE")
    ?? request.headers.get("x-payment")
    ?? undefined;
}

function siwxHeader(request: NextRequest): string | undefined {
  return request.headers.get("SIGN-IN-WITH-X")
    ?? request.headers.get("sign-in-with-x")
    ?? undefined;
}

function requestIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded && forwarded.trim().length > 0) {
    return forwarded.split(",")[0]!.trim();
  }

  return "unknown";
}

function responseFromInstructions(response: HTTPResponseInstructions): NextResponse {
  const headers = new Headers(response.headers);
  const contentType = headers.get("content-type") ?? headers.get("Content-Type");

  if (response.isHtml) {
    headers.set("content-type", "text/html; charset=utf-8");
    return new NextResponse(typeof response.body === "string" ? response.body : String(response.body ?? ""), {
      status: response.status,
      headers,
    });
  }

  if (!contentType) {
    headers.set("content-type", "application/json; charset=utf-8");
  }

  return NextResponse.json(response.body ?? {}, {
    status: response.status,
    headers,
  });
}

function allowedMethodsForRoute(route: RouteSpec): string[] {
  return Array.from(new Set([route.httpMethod, ...(route.alternateMethods ?? []), "OPTIONS"]));
}

function applyCorsHeaders(response: NextResponse, methods: string[]): NextResponse {
  response.headers.set("access-control-allow-origin", "*");
  response.headers.set("access-control-allow-methods", methods.join(", "));
  response.headers.set("access-control-allow-headers", ACCESS_CONTROL_ALLOW_HEADERS);
  response.headers.set("access-control-expose-headers", ACCESS_CONTROL_EXPOSE_HEADERS);
  response.headers.set("access-control-max-age", "86400");
  response.headers.set("allow", methods.join(", "));
  return response;
}

function finalizePublicResponse(
  response: NextResponse,
  methods: string[],
  stripBody = false,
): NextResponse {
  const baseResponse = stripBody
    ? new NextResponse(null, {
      status: response.status,
      headers: new Headers(response.headers),
    })
    : response;

  return applyCorsHeaders(baseResponse, methods);
}

function eventBase(config: GatewayConfig, route?: RouteSpec): Omit<EventRecord, "event" | "timestamp" | "requestId"> {
  if (!route) {
    return {};
  }

  return {
    routePath: route.path,
    cluster: route.cluster,
    provider: route.provider,
    surface: route.surface,
    method: route.method,
    ...(route.paymentRequired
      ? {
        paymentNetwork: config.paymentNetwork,
        paymentAsset: config.usdcMint,
        priceUsd: route.priceUsd,
      }
      : {}),
  };
}

async function recordEvent(state: HostedGatewayState, event: EventRecord, counterKey?: string): Promise<void> {
  logEvent(event);
  if (counterKey) {
    await state.incrementCounter(counterKey);
  }
}

async function createFacilitatorRuntime(): Promise<FacilitatorRuntime> {
  const config = loadConfig();
  const facilitatorSigner = await loadFacilitatorSigner(config);
  const facilitator = new x402Facilitator();
  registerExactSvmFacilitatorScheme(facilitator, {
    signer: toFacilitatorSvmSigner(facilitatorSigner, { defaultRpcUrl: config.solanaMainnetRpcUrl }),
    networks: SOLANA_MAINNET_CAIP2,
  });

  return {
    config,
    facilitator,
  };
}

async function getFacilitatorRuntime(): Promise<FacilitatorRuntime> {
  if (!facilitatorRuntimePromise) {
    facilitatorRuntimePromise = createFacilitatorRuntime().catch((error) => {
      facilitatorRuntimePromise = null;
      throw error;
    });
  }

  return facilitatorRuntimePromise;
}

async function createRuntime(): Promise<GatewayRuntime> {
  const config = loadConfig();
  const state = new HostedGatewayState(config);
  const facilitatorClient = new HTTPFacilitatorClient(
    createFacilitatorConfig(config.cdpApiKeyId, config.cdpApiKeySecret),
  );

  const resourceServer = new x402ResourceServer(facilitatorClient);
  registerExactSvmServerScheme(resourceServer, {
    networks: [SOLANA_MAINNET_CAIP2],
  });
  resourceServer.registerExtension(bazaarResourceServerExtension);
  resourceServer.registerExtension(siwxResourceServerExtension);

  const routes = buildRouteCatalog(config);
  const httpServer = new x402HTTPResourceServer(resourceServer, buildRoutesConfig(config, routes))
    .onProtectedRequest(createSIWxRequestHook({ storage: state }));
  await httpServer.initialize();

  return {
    config,
    state,
    routes,
    catalog: buildCatalogEntries(config, routes),
    httpServer,
  };
}

export async function getGatewayRuntime(): Promise<GatewayRuntime> {
  if (!runtimePromise) {
    runtimePromise = createRuntime().catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }

  return runtimePromise;
}

export async function getCatalog(): Promise<CatalogRouteEntry[]> {
  const runtime = await getGatewayRuntime();
  return runtime.catalog;
}

function normalizeProviderFilter(rawValue: string | null): CatalogRouteEntry["provider"] | null {
  if (!rawValue) {
    return null;
  }

  const normalized = rawValue.trim().toLowerCase();
  switch (normalized) {
    case "alchemy":
      return "alchemy";
    case "helius":
      return "helius";
    case "tokens":
    case "tokensapi":
    case "tokens-api":
      return "tokens";
    default:
      return null;
  }
}

function buildProviderCategories(
  allRoutes: CatalogRouteEntry[],
  baseUrl: string,
): CatalogProviderEntry[] {
  return Object.entries(PROVIDER_LABELS).map(([providerId, label]) => {
    const provider = providerId as CatalogRouteEntry["provider"];
    const href = new URL("/v1/catalog", baseUrl);
    href.searchParams.set("provider", provider);

    return {
      id: provider,
      label,
      routeCount: allRoutes.filter((route) => route.provider === provider).length,
      href: href.toString(),
    };
  });
}

export async function handleCatalogRequest(request?: NextRequest): Promise<NextResponse> {
  const runtime = await getGatewayRuntime();
  const rawProviderFilter = request?.nextUrl.searchParams.get("provider") ?? null;
  const providerFilter = normalizeProviderFilter(rawProviderFilter);

  if (rawProviderFilter && !providerFilter) {
    return finalizePublicResponse(NextResponse.json(
      {
        ok: false,
        error: "invalid_provider_filter",
        supportedProviders: Object.keys(PROVIDER_LABELS),
      },
      { status: 400 },
    ), ["GET", "HEAD", "OPTIONS"], request?.method === "HEAD");
  }

  const routes = providerFilter
    ? runtime.catalog.filter((route) => route.provider === providerFilter)
    : runtime.catalog;
  const categories = buildProviderCategories(runtime.catalog, runtime.config.baseUrl);

  return finalizePublicResponse(NextResponse.json({
    ok: true,
    version: 1,
    payment: {
      modes: ["exact", "siwx"],
      network: runtime.config.paymentNetwork,
      pricingModel: runtime.catalog.some((route) => route.accessMode === "siwx") ? "mixed" : "per-route",
      asset: {
        symbol: runtime.config.paymentAssetSymbol,
        mint: runtime.config.usdcMint,
        decimals: runtime.config.paymentAssetDecimals,
      },
    },
    catalog: {
      totalRoutes: runtime.catalog.length,
      returnedRoutes: routes.length,
      filters: {
        provider: providerFilter,
      },
    },
    categories: {
      providers: categories,
    },
    routes,
  }), ["GET", "HEAD", "OPTIONS"], request?.method === "HEAD");
}

export function handleHealthRequest(request?: NextRequest): NextResponse {
  return finalizePublicResponse(NextResponse.json({
    ok: true,
    service: "agon-gateway",
    status: "healthy",
  }), ["GET", "HEAD", "OPTIONS"], request?.method === "HEAD");
}

export function handleOptionsRequest(methods: string[]): NextResponse {
  return finalizePublicResponse(new NextResponse(null, { status: 204 }), methods);
}

async function parseRequestBody(request: NextRequest): Promise<ParsedRequestBody> {
  const clone = request.clone();
  const text = await clone.text();
  if (!text.trim()) {
    return {
      body: {},
      isEmpty: true,
    };
  }

  return {
    body: JSON.parse(text),
    isEmpty: false,
  };
}

function extractQueryParams(request: NextRequest): { params: URLSearchParams; isEmpty: boolean } {
  const params = new URLSearchParams(request.nextUrl.search);
  return {
    params,
    isEmpty: Array.from(params.keys()).length === 0,
  };
}

function coerceQueryValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }

  if (/^-?\d+$/.test(trimmed)) {
    const asNumber = Number(trimmed);
    if (Number.isSafeInteger(asNumber)) {
      return asNumber;
    }
  }

  if (trimmed === "true") {
    return true;
  }

  if (trimmed === "false") {
    return false;
  }

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
    || (trimmed.startsWith("[") && trimmed.endsWith("]"))
    || (trimmed.startsWith("\"") && trimmed.endsWith("\""))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}

function extractSolanaQueryParams(
  request: NextRequest,
  route: RouteSpec,
): ParsedSolanaQueryParams | { error: string } {
  const { params: searchParams, isEmpty } = extractQueryParams(request);
  if (isEmpty) {
    return {
      params: route.kind === "solana-rpc" ? [] : {},
      isEmpty: true,
    };
  }

  const rawParamsValues = searchParams.getAll("params");
  if (rawParamsValues.length > 1) {
    return { error: 'Query param "params" may be provided at most once.' };
  }

  if (rawParamsValues.length === 1) {
    try {
      return {
        params: JSON.parse(rawParamsValues[0]!),
        isEmpty: false,
      };
    } catch {
      return { error: 'Query param "params" must be valid JSON.' };
    }
  }

  if (route.kind === "solana-rpc") {
    return {
      error: 'RPC GET requests require query param "params" containing a JSON array.',
    };
  }

  const paramsObject: Record<string, unknown> = {};
  const groupedValues = new Map<string, string[]>();
  for (const [key, value] of searchParams.entries()) {
    const existing = groupedValues.get(key);
    if (existing) {
      existing.push(value);
    } else {
      groupedValues.set(key, [value]);
    }
  }

  for (const [key, values] of groupedValues.entries()) {
    paramsObject[key] = values.length === 1
      ? coerceQueryValue(values[0]!)
      : values.map((value) => coerceQueryValue(value));
  }

  return {
    params: paramsObject,
    isEmpty: false,
  };
}

function validateEnvelopeBody(route: RouteSpec, body: unknown): { params: unknown } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Request body must be a JSON object." };
  }

  const params = (body as Record<string, unknown>).params;
  if (route.kind === "solana-rpc") {
    return Array.isArray(params)
      ? { params }
      : { error: 'RPC routes require body shape: { "params": [...] }.' };
  }

  return params && typeof params === "object" && !Array.isArray(params)
    ? { params }
    : { error: 'DAS routes require body shape: { "params": { ... } }.' };
}

async function extractRouteParams(
  request: NextRequest,
  resolvedRoute: ResolvedRoute,
  hasAccessHeader: boolean,
): Promise<{ params: unknown; isDiscoveryProbe: boolean } | { error: string; status: number }> {
  if (resolvedRoute.route.inputMode === "query") {
    const { params, isEmpty } = extractQueryParams(request);
    const isDiscoveryProbe = !hasAccessHeader && isEmpty;
    if (isDiscoveryProbe) {
      return { params, isDiscoveryProbe: true };
    }

    const paramsError = validateRouteParams(resolvedRoute.route, params, resolvedRoute.pathParams);
    if (paramsError) {
      return { error: paramsError, status: 400 };
    }

    return { params, isDiscoveryProbe: false };
  }

  if (
    resolvedRoute.route.inputMode === "solana-envelope"
    && (request.method === "GET" || request.method === "HEAD")
  ) {
    const extracted = extractSolanaQueryParams(request, resolvedRoute.route);
    if ("error" in extracted) {
      return { error: extracted.error, status: 400 };
    }

    const isDiscoveryProbe = !hasAccessHeader && extracted.isEmpty;
    if (isDiscoveryProbe) {
      return { params: extracted.params, isDiscoveryProbe: true };
    }

    const paramsError = validateRouteParams(resolvedRoute.route, extracted.params, resolvedRoute.pathParams);
    if (paramsError) {
      return { error: paramsError, status: 400 };
    }

    return { params: extracted.params, isDiscoveryProbe: false };
  }

  let parsedBody: ParsedRequestBody;
  try {
    parsedBody = await parseRequestBody(request);
  } catch {
    return { error: "Request body must be valid JSON.", status: 400 };
  }

  const isDiscoveryProbe = !hasAccessHeader && parsedBody.isEmpty;
  if (isDiscoveryProbe) {
    return { params: {}, isDiscoveryProbe: true };
  }

  if (resolvedRoute.route.inputMode === "solana-envelope") {
    const extracted = validateEnvelopeBody(resolvedRoute.route, parsedBody.body);
    if ("error" in extracted) {
      return { error: extracted.error, status: 400 };
    }

    const paramsError = validateRouteParams(resolvedRoute.route, extracted.params, resolvedRoute.pathParams);
    if (paramsError) {
      return { error: paramsError, status: 400 };
    }

    return { params: extracted.params, isDiscoveryProbe: false };
  }

  const paramsError = validateRouteParams(resolvedRoute.route, parsedBody.body, resolvedRoute.pathParams);
  if (paramsError) {
    return { error: paramsError, status: 400 };
  }

  return { params: parsedBody.body, isDiscoveryProbe: false };
}

function requestMethod(request: NextRequest): HttpMethod | null {
  if (request.method === "GET" || request.method === "POST" || request.method === "HEAD") {
    return request.method;
  }
  return null;
}

function upstreamFailureResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof UpstreamHttpError) {
    if (error.exposeBody && error.body && typeof error.body === "object" && !Array.isArray(error.body)) {
      return {
        status: error.status,
        body: {
          ok: false,
          ...(error.body as Record<string, unknown>),
        },
      };
    }

    return {
      status: error.status,
      body: {
        ok: false,
        error: "upstream_request_failed",
      },
    };
  }

  return {
    status: 502,
    body: {
      ok: false,
      error: "upstream_request_failed",
    },
  };
}

async function handleGrantedRouteRequest(
  runtime: GatewayRuntime,
  resolvedRoute: ResolvedRoute,
  requestId: string,
  params: unknown,
): Promise<NextResponse> {
  const route = resolvedRoute.route;
  const providerLimit = await runtime.state.consumeRateLimit(
    `upstream:${route.rateLimitScope}`,
    route.rateLimitLimit,
    route.rateLimitWindowMs,
  );

  if (!providerLimit.allowed) {
    return NextResponse.json(
      { ok: false, error: "rate_limited", reason: "provider_rate_limit" },
      { status: 429, headers: { "retry-after": String(providerLimit.retryAfterSeconds) } },
    );
  }

  await recordEvent(runtime.state, {
    event: "upstream_request_started",
    timestamp: new Date().toISOString(),
    requestId,
    ...eventBase(runtime.config, route),
  });

  const upstreamStartedAt = Date.now();
  let upstream;
  let upstreamLatencyMs = 0;
  try {
    upstream = await forwardToUpstream(runtime.config, resolvedRoute, params);
    upstreamLatencyMs = Date.now() - upstreamStartedAt;
  } catch (error) {
    upstreamLatencyMs = Date.now() - upstreamStartedAt;
    const failureResponse = upstreamFailureResponse(error);

    await recordEvent(runtime.state, {
      event: "upstream_request_failed",
      timestamp: new Date().toISOString(),
      requestId,
      ...eventBase(runtime.config, route),
      upstreamLatencyMs,
      httpStatus: failureResponse.status,
      detail: {
        error: error instanceof Error ? error.message : "upstream_failed",
      },
    }, "upstream_request_failed");

    return NextResponse.json(failureResponse.body, { status: failureResponse.status });
  }

  await recordEvent(runtime.state, {
    event: "upstream_request_succeeded",
    timestamp: new Date().toISOString(),
    requestId,
    ...eventBase(runtime.config, route),
    upstreamLatencyMs,
    httpStatus: upstream.status,
  }, "upstream_request_succeeded");

  await recordEvent(runtime.state, {
    event: "usage_recorded",
    timestamp: new Date().toISOString(),
    requestId,
    ...eventBase(runtime.config, route),
    upstreamLatencyMs,
    httpStatus: 200,
  }, `usage:${route.provider}:${route.cluster ?? "none"}:${route.surface}:${route.method}`);

  return NextResponse.json(
    {
      ok: true,
      provider: route.provider,
      cluster: route.cluster,
      surface: route.surface,
      method: route.method,
      accessMode: route.accessMode,
      paymentRequired: route.paymentRequired,
      result: upstream.result,
    },
    {
      status: 200,
    },
  );
}

export async function handlePaidRouteRequest(request: NextRequest): Promise<NextResponse> {
  const runtime = await getGatewayRuntime();
  const requestId = randomUUID();
  const requestedMethod = requestMethod(request);
  if (!requestedMethod) {
    const matchedRoute = resolveRouteByPath(runtime.routes, request.nextUrl.pathname);
    const methods = matchedRoute ? allowedMethodsForRoute(matchedRoute.route) : ["OPTIONS"];
    return finalizePublicResponse(
      NextResponse.json({ ok: false, error: "Method not allowed." }, { status: 405 }),
      methods,
      request.method === "HEAD",
    );
  }

  const resolvedRoute = resolveRoute(runtime.routes, requestedMethod, request.nextUrl.pathname);
  if (!resolvedRoute) {
    return finalizePublicResponse(
      NextResponse.json({ ok: false, error: "Not found." }, { status: 404 }),
      ["OPTIONS"],
      request.method === "HEAD",
    );
  }

  const route = resolvedRoute.route;
  const allowedMethods = allowedMethodsForRoute(route);
  const rawPaymentHeader = paymentHeader(request);
  const rawSiwxHeader = siwxHeader(request);
  const extractedParams = await extractRouteParams(request, resolvedRoute, Boolean(rawPaymentHeader || rawSiwxHeader));
  if ("error" in extractedParams) {
    return finalizePublicResponse(
      NextResponse.json({ ok: false, error: extractedParams.error }, { status: extractedParams.status }),
      allowedMethods,
      requestedMethod === "HEAD",
    );
  }

  if (!rawPaymentHeader && !rawSiwxHeader) {
    const challengeLimit = await runtime.state.consumeRateLimit(
      `challenge:${requestIp(request)}`,
      runtime.config.challengeRateLimitPerMinute,
      60_000,
    );

    if (!challengeLimit.allowed) {
      return finalizePublicResponse(NextResponse.json(
        { ok: false, error: "rate_limited", reason: "challenge_rate_limit" },
        { status: 429, headers: { "retry-after": String(challengeLimit.retryAfterSeconds) } },
      ), allowedMethods, requestedMethod === "HEAD");
    }
  } else if (rawPaymentHeader) {
    await recordEvent(runtime.state, {
      event: "payment_received",
      timestamp: new Date().toISOString(),
      requestId,
      ...eventBase(runtime.config, route),
      httpStatus: 202,
    }, "payment_received");
  } else {
    await recordEvent(runtime.state, {
      event: "auth_received",
      timestamp: new Date().toISOString(),
      requestId,
      ...eventBase(runtime.config, route),
      httpStatus: 202,
    }, "auth_received");
  }

  const adapter = new NextAdapter(request);
  const httpContext = {
    adapter,
    path: request.nextUrl.pathname,
    method: route.httpMethod,
    paymentHeader: rawPaymentHeader,
  };

  let processResult: HTTPProcessResult;
  try {
    processResult = await runtime.httpServer.processHTTPRequest(httpContext);
  } catch (error) {
    await recordEvent(runtime.state, {
      event: "request_failed",
      timestamp: new Date().toISOString(),
      requestId,
      ...eventBase(runtime.config, route),
      httpStatus: 500,
      detail: {
        error: error instanceof Error ? error.message : "payment_processing_failed",
      },
    }, "request_failed");
    return finalizePublicResponse(
      NextResponse.json({ ok: false, error: "Internal server error." }, { status: 500 }),
      allowedMethods,
      requestedMethod === "HEAD",
    );
  }

  if (processResult.type === "no-payment-required") {
    await recordEvent(runtime.state, {
      event: route.accessMode === "siwx" ? "auth_verified" : "access_granted",
      timestamp: new Date().toISOString(),
      requestId,
      ...eventBase(runtime.config, route),
      httpStatus: 200,
    }, route.accessMode === "siwx" ? "auth_verified" : "access_granted");
    const grantedResponse = await handleGrantedRouteRequest(runtime, resolvedRoute, requestId, extractedParams.params);
    return finalizePublicResponse(grantedResponse, allowedMethods, requestedMethod === "HEAD");
  }

  if (processResult.type === "payment-error") {
    const event = rawPaymentHeader
      ? "payment_verification_failed"
      : rawSiwxHeader
        ? "auth_verification_failed"
        : "challenge_issued";

    await recordEvent(runtime.state, {
      event,
      timestamp: new Date().toISOString(),
      requestId,
      ...eventBase(runtime.config, route),
      httpStatus: processResult.response.status,
      detail: rawPaymentHeader
        ? { reason: "verification_failed" }
        : rawSiwxHeader
          ? { reason: "authentication_failed" }
          : undefined,
    }, event);
    return finalizePublicResponse(
      responseFromInstructions(processResult.response),
      allowedMethods,
      requestedMethod === "HEAD",
    );
  }

  const replayKey = createHash("sha256").update(rawPaymentHeader ?? requestId).digest("hex");
  const replayReservation = await runtime.state.reserveReplay(replayKey);
  if (!replayReservation.ok) {
    return finalizePublicResponse(NextResponse.json(
      { ok: false, error: "payment_already_used", state: replayReservation.state },
      { status: 409 },
    ), allowedMethods, requestedMethod === "HEAD");
  }

  const providerLimit = await runtime.state.consumeRateLimit(
    `upstream:${route.rateLimitScope}`,
    route.rateLimitLimit,
    route.rateLimitWindowMs,
  );

  if (!providerLimit.allowed) {
    await runtime.state.releaseReplay(replayKey);
    return finalizePublicResponse(NextResponse.json(
      { ok: false, error: "rate_limited", reason: "provider_rate_limit" },
      { status: 429, headers: { "retry-after": String(providerLimit.retryAfterSeconds) } },
    ), allowedMethods, requestedMethod === "HEAD");
  }

  await recordEvent(runtime.state, {
    event: "payment_verified",
    timestamp: new Date().toISOString(),
    requestId,
    ...eventBase(runtime.config, route),
    httpStatus: 200,
  }, "payment_verified");

  await recordEvent(runtime.state, {
    event: "upstream_request_started",
    timestamp: new Date().toISOString(),
    requestId,
    ...eventBase(runtime.config, route),
  });

  const upstreamStartedAt = Date.now();
  let upstream;
  let upstreamLatencyMs = 0;
  try {
    upstream = await forwardToUpstream(runtime.config, resolvedRoute, extractedParams.params);
    upstreamLatencyMs = Date.now() - upstreamStartedAt;
  } catch (error) {
    upstreamLatencyMs = Date.now() - upstreamStartedAt;
    await runtime.state.releaseReplay(replayKey);
    const failureResponse = upstreamFailureResponse(error);

    await recordEvent(runtime.state, {
      event: "upstream_request_failed",
      timestamp: new Date().toISOString(),
      requestId,
      ...eventBase(runtime.config, route),
      upstreamLatencyMs,
      httpStatus: failureResponse.status,
      detail: {
        error: error instanceof Error ? error.message : "upstream_failed",
      },
    }, "upstream_request_failed");

    return finalizePublicResponse(
      NextResponse.json(failureResponse.body, { status: failureResponse.status }),
      allowedMethods,
      requestedMethod === "HEAD",
    );
  }

  await recordEvent(runtime.state, {
    event: "upstream_request_succeeded",
    timestamp: new Date().toISOString(),
    requestId,
    ...eventBase(runtime.config, route),
    upstreamLatencyMs,
    httpStatus: upstream.status,
  }, "upstream_request_succeeded");

  await recordEvent(runtime.state, {
    event: "payment_settle_started",
    timestamp: new Date().toISOString(),
    requestId,
    ...eventBase(runtime.config, route),
  });

  const settlement = await runtime.httpServer.processSettlement(
    processResult.paymentPayload,
    processResult.paymentRequirements,
    processResult.declaredExtensions,
    { request: httpContext },
  );

  if (!settlement.success) {
    await runtime.state.releaseReplay(replayKey);
    await recordEvent(runtime.state, {
      event: "payment_settle_failed",
      timestamp: new Date().toISOString(),
      requestId,
      ...eventBase(runtime.config, route),
      httpStatus: settlement.response.status,
      detail: {
        error: settlement.errorReason,
      },
    }, "payment_settle_failed");
    return finalizePublicResponse(
      responseFromInstructions(settlement.response),
      allowedMethods,
      requestedMethod === "HEAD",
    );
  }

  await runtime.state.markReplaySettled(replayKey);
  await recordEvent(runtime.state, {
    event: "payment_settle_succeeded",
    timestamp: new Date().toISOString(),
    requestId,
    ...eventBase(runtime.config, route),
    wallet: settlement.payer,
    httpStatus: 200,
    detail: {
      transaction: settlement.transaction,
    },
  }, "payment_settle_succeeded");

  await recordEvent(runtime.state, {
    event: "usage_recorded",
    timestamp: new Date().toISOString(),
    requestId,
    ...eventBase(runtime.config, route),
    wallet: settlement.payer,
    upstreamLatencyMs,
    httpStatus: 200,
  }, `usage:${route.provider}:${route.cluster ?? "none"}:${route.surface}:${route.method}`);

  return finalizePublicResponse(NextResponse.json(
    {
      ok: true,
      provider: route.provider,
      cluster: route.cluster,
      surface: route.surface,
      method: route.method,
      ...(route.priceUsd ? { priceUsd: route.priceUsd } : {}),
      paymentNetwork: runtime.config.paymentNetwork,
      result: upstream.result,
    },
    {
      status: 200,
      headers: settlement.headers,
    },
  ), allowedMethods, requestedMethod === "HEAD");
}

export async function handlePaidRouteOptionsRequest(request: NextRequest): Promise<NextResponse> {
  const runtime = await getGatewayRuntime();
  const resolvedRoute = resolveRouteByPath(runtime.routes, request.nextUrl.pathname);
  if (!resolvedRoute) {
    return finalizePublicResponse(
      NextResponse.json({ ok: false, error: "Not found." }, { status: 404 }),
      ["OPTIONS"],
    );
  }

  return finalizePublicResponse(
    new NextResponse(null, { status: 204 }),
    allowedMethodsForRoute(resolvedRoute.route),
  );
}

export async function requireInternalAuth(request: NextRequest): Promise<NextResponse | null> {
  const { config } = await getFacilitatorRuntime();
  if (!config.internalSettlementSecret) {
    return NextResponse.json({ ok: false, error: "Internal facilitator is not configured." }, { status: 500 });
  }

  const header = request.headers.get("x-agon-internal-secret");
  if (header !== config.internalSettlementSecret) {
    return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
  }

  return null;
}

export async function handleFacilitatorSupportedRequest(): Promise<NextResponse> {
  const { facilitator } = await getFacilitatorRuntime();
  return NextResponse.json(facilitator.getSupported());
}

export async function handleFacilitatorVerifyRequest(request: NextRequest): Promise<NextResponse> {
  const { facilitator } = await getFacilitatorRuntime();
  const parsedBody = await parseRequestBody(request);
  const body = parsedBody.body as Record<string, unknown>;
  const verification = await facilitator.verify(
    body.paymentPayload as Parameters<typeof facilitator.verify>[0],
    body.paymentRequirements as Parameters<typeof facilitator.verify>[1],
  );

  return NextResponse.json(verification);
}

export async function handleFacilitatorSettleRequest(request: NextRequest): Promise<NextResponse> {
  const { facilitator } = await getFacilitatorRuntime();
  const parsedBody = await parseRequestBody(request);
  const body = parsedBody.body as Record<string, unknown>;
  const settlement = await facilitator.settle(
    body.paymentPayload as Parameters<typeof facilitator.settle>[0],
    body.paymentRequirements as Parameters<typeof facilitator.settle>[1],
  );

  return NextResponse.json(settlement);
}
