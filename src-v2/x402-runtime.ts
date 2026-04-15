import { createHash, randomUUID } from "node:crypto";
import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer, type HTTPProcessResult, type HTTPResponseInstructions, type RouteConfig, type RoutesConfig } from "@x402/core/server";
import { x402Facilitator } from "@x402/core/facilitator";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { NextAdapter } from "@x402/next";
import { SOLANA_MAINNET_CAIP2, toFacilitatorSvmSigner } from "@x402/svm";
import { registerExactSvmScheme as registerExactSvmServerScheme } from "@x402/svm/exact/server";
import { registerExactSvmScheme as registerExactSvmFacilitatorScheme } from "@x402/svm/exact/facilitator";
import { NextRequest, NextResponse } from "next/server";
import { buildCatalogEntries, buildRouteCatalog, routeCatalogMap, validateRouteParams } from "./catalog";
import { loadConfig } from "./config";
import { loadFacilitatorSigner } from "./facilitator-wallet";
import { HostedGatewayState } from "./hosted-state";
import { logEvent } from "./hosted-logger";
import type { CatalogRouteEntry, EventRecord, GatewayConfig, RouteSpec } from "./types";
import { forwardToUpstream } from "./upstream";

interface GatewayRuntime {
  config: GatewayConfig;
  state: HostedGatewayState;
  routes: RouteSpec[];
  routeMap: Map<string, RouteSpec>;
  catalog: CatalogRouteEntry[];
  httpServer: x402HTTPResourceServer;
  facilitator: x402Facilitator;
}

let runtimePromise: Promise<GatewayRuntime> | null = null;

function buildDiscoveryExtension(config: GatewayConfig, route: RouteSpec) {
  return declareDiscoveryExtension({
    input: route.paramsShape === "array"
      ? { params: [] }
      : { params: {} },
    inputSchema: route.inputSchema,
    bodyType: "json",
    output: {
      example: {
        ok: true,
        provider: route.provider,
        cluster: route.cluster,
        surface: route.surface,
        method: route.method,
        priceUsd: config.priceUsd,
        paymentNetwork: config.paymentNetwork,
        result: route.surface === "rpc" ? {} : { items: [] }
      },
      schema: route.outputSchema
    }
  });
}

function buildRoutesConfig(config: GatewayConfig, routes: RouteSpec[]): RoutesConfig {
  const paymentPrice = config.priceUsd.startsWith("$") ? config.priceUsd : `$${config.priceUsd}`;
  const entries: Record<string, RouteConfig> = {};

  for (const route of routes) {
    entries[`POST ${route.path}`] = {
      accepts: {
        scheme: "exact",
        price: paymentPrice,
        network: SOLANA_MAINNET_CAIP2,
        payTo: config.payToWallet,
      },
      description: route.description,
      mimeType: "application/json",
      extensions: buildDiscoveryExtension(config, route),
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
    paymentNetwork: config.paymentNetwork,
    paymentAsset: config.usdcMint,
    priceUsd: config.priceUsd,
  };
}

async function recordEvent(state: HostedGatewayState, event: EventRecord, counterKey?: string): Promise<void> {
  logEvent(event);
  if (counterKey) {
    await state.incrementCounter(counterKey);
  }
}

async function createRuntime(): Promise<GatewayRuntime> {
  const config = loadConfig();
  const facilitatorSigner = await loadFacilitatorSigner(config);
  const facilitator = new x402Facilitator();
  registerExactSvmFacilitatorScheme(facilitator, {
    signer: toFacilitatorSvmSigner(facilitatorSigner, { defaultRpcUrl: config.solanaMainnetRpcUrl }),
    networks: SOLANA_MAINNET_CAIP2,
  });

  const facilitatorClient = new HTTPFacilitatorClient({
    url: `${config.baseUrl}/api/internal/facilitator`,
    createAuthHeaders: async () => ({
      verify: { "x-agon-internal-secret": config.internalSettlementSecret },
      settle: { "x-agon-internal-secret": config.internalSettlementSecret },
      supported: { "x-agon-internal-secret": config.internalSettlementSecret },
    }),
  });

  const resourceServer = new x402ResourceServer(facilitatorClient);
  registerExactSvmServerScheme(resourceServer, {
    networks: [SOLANA_MAINNET_CAIP2],
  });
  resourceServer.registerExtension(bazaarResourceServerExtension);

  const routes = buildRouteCatalog();
  const httpServer = new x402HTTPResourceServer(resourceServer, buildRoutesConfig(config, routes));
  await httpServer.initialize();

  return {
    config,
    state: new HostedGatewayState(config),
    routes,
    routeMap: routeCatalogMap(routes),
    catalog: buildCatalogEntries(config, routes),
    httpServer,
    facilitator,
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

export async function handleCatalogRequest(): Promise<NextResponse> {
  const runtime = await getGatewayRuntime();
  return NextResponse.json({
    ok: true,
    version: 1,
    payment: {
      scheme: "exact",
      network: runtime.config.paymentNetwork,
      priceUsd: runtime.config.priceUsd,
      asset: {
        symbol: runtime.config.paymentAssetSymbol,
        mint: runtime.config.usdcMint,
        decimals: runtime.config.paymentAssetDecimals,
      },
    },
    routes: runtime.catalog,
  });
}

export function handleHealthRequest(): NextResponse {
  return NextResponse.json({
    ok: true,
    service: "agon-gateway",
    status: "healthy",
  });
}

async function parseRequestBody(request: NextRequest): Promise<unknown> {
  const clone = request.clone();
  const text = await clone.text();
  if (!text.trim()) {
    return {};
  }

  return JSON.parse(text);
}

function validateBodyForRoute(route: RouteSpec, body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Request body must be a JSON object.";
  }

  const params = (body as Record<string, unknown>).params;
  if (route.paramsShape === "array") {
    return Array.isArray(params) ? null : 'RPC routes require body shape: { "params": [...] }.';
  }

  return params && typeof params === "object" && !Array.isArray(params)
    ? null
    : 'DAS routes require body shape: { "params": { ... } }.';
}

export async function handlePaidRouteRequest(request: NextRequest): Promise<NextResponse> {
  const runtime = await getGatewayRuntime();
  const requestId = randomUUID();
  const route = runtime.routeMap.get(request.nextUrl.pathname);

  if (!route) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await parseRequestBody(request);
  } catch {
    return NextResponse.json({ ok: false, error: "Request body must be valid JSON." }, { status: 400 });
  }

  const bodyError = validateBodyForRoute(route, body);
  if (bodyError) {
    return NextResponse.json({ ok: false, error: bodyError }, { status: 400 });
  }

  const params = (body as { params: unknown }).params;
  const paramsError = validateRouteParams(route, params);
  if (paramsError) {
    return NextResponse.json({ ok: false, error: paramsError }, { status: 400 });
  }

  const rawPaymentHeader = paymentHeader(request);
  if (!rawPaymentHeader) {
    const challengeLimit = await runtime.state.consumeRateLimit(
      `challenge:${requestIp(request)}`,
      runtime.config.challengeRateLimitPerMinute,
      60_000,
    );

    if (!challengeLimit.allowed) {
      return NextResponse.json(
        { ok: false, error: "rate_limited", reason: "challenge_rate_limit" },
        { status: 429, headers: { "retry-after": String(challengeLimit.retryAfterSeconds) } },
      );
    }
  } else {
    await recordEvent(runtime.state, {
      event: "payment_received",
      timestamp: new Date().toISOString(),
      requestId,
      ...eventBase(runtime.config, route),
      httpStatus: 202,
    }, "payment_received");
  }

  const adapter = new NextAdapter(request);
  const httpContext = {
    adapter,
    path: request.nextUrl.pathname,
    method: request.method,
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
    return NextResponse.json({ ok: false, error: "Internal server error." }, { status: 500 });
  }

  if (processResult.type === "no-payment-required") {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  if (processResult.type === "payment-error") {
    await recordEvent(runtime.state, {
      event: rawPaymentHeader ? "payment_verified" : "challenge_issued",
      timestamp: new Date().toISOString(),
      requestId,
      ...eventBase(runtime.config, route),
      httpStatus: processResult.response.status,
      detail: rawPaymentHeader ? { reason: "verification_failed" } : undefined,
    }, rawPaymentHeader ? "payment_verification_failed" : "challenge_issued");
    return responseFromInstructions(processResult.response);
  }

  const replayKey = createHash("sha256").update(rawPaymentHeader ?? requestId).digest("hex");
  const replayReservation = await runtime.state.reserveReplay(replayKey);
  if (!replayReservation.ok) {
    return NextResponse.json(
      { ok: false, error: "payment_already_used", state: replayReservation.state },
      { status: 409 },
    );
  }

  const providerLimit = await runtime.state.consumeRateLimit(
    `upstream:${route.provider}:${route.cluster}:${route.surface}`,
    route.surface === "das" ? runtime.config.dasRateLimitPerSecond : runtime.config.rpcRateLimitPerSecond,
    1_000,
  );

  if (!providerLimit.allowed) {
    await runtime.state.releaseReplay(replayKey);
    return NextResponse.json(
      { ok: false, error: "rate_limited", reason: "provider_rate_limit" },
      { status: 429, headers: { "retry-after": String(providerLimit.retryAfterSeconds) } },
    );
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
    upstream = await forwardToUpstream(runtime.config, route, params);
    upstreamLatencyMs = Date.now() - upstreamStartedAt;
  } catch (error) {
    upstreamLatencyMs = Date.now() - upstreamStartedAt;
    await runtime.state.releaseReplay(replayKey);
    await recordEvent(runtime.state, {
      event: "upstream_request_failed",
      timestamp: new Date().toISOString(),
      requestId,
      ...eventBase(runtime.config, route),
      upstreamLatencyMs,
      httpStatus: 502,
      detail: {
        error: error instanceof Error ? error.message : "upstream_failed",
      },
    }, "upstream_request_failed");

    return NextResponse.json(
      {
        ok: false,
        error: "upstream_request_failed",
      },
      {
        status: 502,
      },
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
    return responseFromInstructions(settlement.response);
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
  }, `usage:${route.provider}:${route.cluster}:${route.surface}:${route.method}`);

  return NextResponse.json(
    {
      ok: true,
      provider: route.provider,
      cluster: route.cluster,
      surface: route.surface,
      method: route.method,
      priceUsd: runtime.config.priceUsd,
      paymentNetwork: runtime.config.paymentNetwork,
      result: upstream.result,
    },
    {
      status: 200,
      headers: settlement.headers,
    },
  );
}

export async function requireInternalAuth(request: NextRequest): Promise<NextResponse | null> {
  const runtime = await getGatewayRuntime();
  const header = request.headers.get("x-agon-internal-secret");

  if (header !== runtime.config.internalSettlementSecret) {
    return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
  }

  return null;
}

export async function handleFacilitatorSupportedRequest(): Promise<NextResponse> {
  const runtime = await getGatewayRuntime();
  return NextResponse.json(runtime.facilitator.getSupported());
}

export async function handleFacilitatorVerifyRequest(request: NextRequest): Promise<NextResponse> {
  const runtime = await getGatewayRuntime();
  const body = await parseRequestBody(request) as Record<string, unknown>;
  const verification = await runtime.facilitator.verify(
    body.paymentPayload as Parameters<typeof runtime.facilitator.verify>[0],
    body.paymentRequirements as Parameters<typeof runtime.facilitator.verify>[1],
  );

  return NextResponse.json(verification);
}

export async function handleFacilitatorSettleRequest(request: NextRequest): Promise<NextResponse> {
  const runtime = await getGatewayRuntime();
  const body = await parseRequestBody(request) as Record<string, unknown>;
  const settlement = await runtime.facilitator.settle(
    body.paymentPayload as Parameters<typeof runtime.facilitator.settle>[0],
    body.paymentRequirements as Parameters<typeof runtime.facilitator.settle>[1],
  );

  return NextResponse.json(settlement);
}
