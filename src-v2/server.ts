import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { buildCatalogEntries, buildRouteCatalog, routeCatalogMap } from "./catalog.js";
import { loadConfig } from "./config.js";
import { FixedWindowRateLimiter, ReplayProtector } from "./guards.js";
import { EventLogger } from "./logger.js";
import type { EventRecord, RequestContext, RouteSpec } from "./types.js";
import { forwardToUpstream } from "./upstream.js";
import { ExactSvmFacilitator } from "./x402.js";

const config = loadConfig();
const logger = new EventLogger(config.eventLogPath);
const facilitator = new ExactSvmFacilitator(config);
const replayProtector = new ReplayProtector();
const rateLimiter = new FixedWindowRateLimiter();
const routes = buildRouteCatalog();
const routeMap = routeCatalogMap(routes);
const catalog = buildCatalogEntries(config, routes);

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  extraHeaders?: Record<string, string>
): void {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders
  };
  response.writeHead(statusCode, headers);
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) {
    return {};
  }

  return JSON.parse(raw);
}

function createRequestContext(): RequestContext {
  return {
    requestId: randomUUID(),
    startedAtMs: Date.now()
  };
}

function logEvent(event: EventRecord): void {
  logger.log(event);
}

function validateBodyForRoute(route: RouteSpec, body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Request body must be a JSON object.";
  }

  const params = (body as Record<string, unknown>).params;
  if (route.paramsShape === "array") {
    if (!Array.isArray(params)) {
      return 'RPC routes require body shape: { "params": [...] }.';
    }
    return null;
  }

  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return 'DAS routes require body shape: { "params": { ... } }.';
  }
  return null;
}

function challengeHeaders(route: RouteSpec): Record<string, string> {
  return {
    [facilitator.getHeaders().paymentRequired]: facilitator.encodeChallenge(route)
  };
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", config.baseUrl);
}

function requestIp(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim().length > 0) {
    return forwarded.split(",")[0]!.trim();
  }

  return request.socket.remoteAddress ?? "unknown";
}

function requireInternalSettlementAuth(request: IncomingMessage): boolean {
  const header = request.headers["x-agon-internal-secret"];
  return typeof header === "string" && header === config.internalSettlementSecret;
}

function providerRateLimit(route: RouteSpec): number {
  return route.surface === "das"
    ? config.dasRateLimitPerSecond
    : config.rpcRateLimitPerSecond;
}

function sendRateLimited(
  response: ServerResponse,
  retryAfterSeconds: number,
  reason: string
): void {
  sendJson(
    response,
    429,
    {
      ok: false,
      error: "rate_limited",
      reason
    },
    {
      "retry-after": String(retryAfterSeconds)
    }
  );
}

async function handlePaidRoute(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
  route: RouteSpec
): Promise<void> {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "Method not allowed." });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch {
    sendJson(response, 400, { ok: false, error: "Request body must be valid JSON." });
    return;
  }

  const bodyError = validateBodyForRoute(route, body);
  if (bodyError) {
    sendJson(response, 400, { ok: false, error: bodyError });
    return;
  }

  const challengeRate = rateLimiter.consume(
    `challenge:${requestIp(request)}`,
    config.challengeRateLimitPerMinute,
    60_000
  );
  if (!challengeRate.allowed) {
    sendRateLimited(response, challengeRate.retryAfterSeconds, "challenge_rate_limit");
    return;
  }

  const paymentHeader = request.headers["payment-signature"];
  if (typeof paymentHeader !== "string" || paymentHeader.trim().length === 0) {
    logEvent({
      event: "challenge_issued",
      timestamp: new Date().toISOString(),
      requestId: context.requestId,
      routePath: route.path,
      cluster: route.cluster,
      provider: route.provider,
      surface: route.surface,
      method: route.method,
      paymentNetwork: config.paymentNetwork,
      paymentAsset: config.usdcMint,
      priceUsd: config.priceUsd,
      httpStatus: 402
    });
    sendJson(
      response,
      402,
      {
        ok: false,
        error: "payment_required",
        route: route.path
      },
      challengeHeaders(route)
    );
    return;
  }

  let paymentPayload: unknown;
  try {
    paymentPayload = facilitator.decodePaymentHeader(paymentHeader);
  } catch {
    logEvent({
      event: "challenge_issued",
      timestamp: new Date().toISOString(),
      requestId: context.requestId,
      routePath: route.path,
      cluster: route.cluster,
      provider: route.provider,
      surface: route.surface,
      method: route.method,
      paymentNetwork: config.paymentNetwork,
      paymentAsset: config.usdcMint,
      priceUsd: config.priceUsd,
      httpStatus: 402,
      detail: { reason: "invalid_payment_header_encoding" }
    });
    sendJson(
      response,
      402,
      {
        ok: false,
        error: "invalid_payment_header"
      },
      challengeHeaders(route)
    );
    return;
  }

  logEvent({
    event: "payment_received",
    timestamp: new Date().toISOString(),
    requestId: context.requestId,
    routePath: route.path,
    cluster: route.cluster,
    provider: route.provider,
    surface: route.surface,
    method: route.method,
    paymentNetwork: config.paymentNetwork,
    paymentAsset: config.usdcMint,
    priceUsd: config.priceUsd,
    httpStatus: 202
  });

  const verification = facilitator.verify(route, paymentPayload);
  logEvent({
    event: "payment_verified",
    timestamp: new Date().toISOString(),
    requestId: context.requestId,
    routePath: route.path,
    cluster: route.cluster,
    provider: route.provider,
    surface: route.surface,
    method: route.method,
    wallet: verification.payer,
    paymentNetwork: config.paymentNetwork,
    paymentAsset: config.usdcMint,
    priceUsd: config.priceUsd,
    httpStatus: verification.success ? 200 : 402,
    detail: verification.success ? undefined : { error: verification.error }
  });

  if (!verification.success) {
    sendJson(
      response,
      402,
      {
        ok: false,
        error: "payment_verification_failed",
        reason: verification.error
      },
      challengeHeaders(route)
    );
    return;
  }

  const replayKey = verification.settlementCacheKey!;
  const reservation = replayProtector.reserve(replayKey);
  if (!reservation.ok) {
    sendJson(
      response,
      409,
      {
        ok: false,
        error: "payment_already_used",
        state: reservation.state
      }
    );
    return;
  }

  const upstreamQuota = rateLimiter.consume(
    `upstream:${route.provider}:${route.surface}`,
    providerRateLimit(route),
    1_000
  );
  if (!upstreamQuota.allowed) {
    replayProtector.release(replayKey);
    sendRateLimited(response, upstreamQuota.retryAfterSeconds, "provider_rate_limit");
    return;
  }

  logEvent({
    event: "payment_settle_started",
    timestamp: new Date().toISOString(),
    requestId: context.requestId,
    routePath: route.path,
    cluster: route.cluster,
    provider: route.provider,
    surface: route.surface,
    method: route.method,
    wallet: verification.payer,
    paymentNetwork: config.paymentNetwork,
    paymentAsset: config.usdcMint,
    priceUsd: config.priceUsd
  });

  const settlement = await facilitator.settle(route, paymentPayload);
  if (!settlement.success) {
    replayProtector.release(replayKey);
    logEvent({
      event: "payment_settle_failed",
      timestamp: new Date().toISOString(),
      requestId: context.requestId,
      routePath: route.path,
      cluster: route.cluster,
      provider: route.provider,
      surface: route.surface,
      method: route.method,
      wallet: settlement.payer,
      paymentNetwork: config.paymentNetwork,
      paymentAsset: config.usdcMint,
      priceUsd: config.priceUsd,
      httpStatus: 402,
      detail: { error: settlement.error }
    });
    sendJson(
      response,
      402,
      {
        ok: false,
        error: "payment_settlement_failed",
        reason: settlement.error
      },
      {
        ...challengeHeaders(route),
        [facilitator.getHeaders().paymentResponse]: facilitator.encodeSettlementResponse(settlement)
      }
    );
    return;
  }

  replayProtector.markSettled(replayKey);
  logEvent({
    event: "payment_settle_succeeded",
    timestamp: new Date().toISOString(),
    requestId: context.requestId,
    routePath: route.path,
    cluster: route.cluster,
    provider: route.provider,
    surface: route.surface,
    method: route.method,
    wallet: settlement.payer,
    paymentNetwork: config.paymentNetwork,
    paymentAsset: config.usdcMint,
    priceUsd: config.priceUsd,
    httpStatus: 200,
    detail: { transaction: settlement.transaction }
  });

  const params = (body as { params: unknown }).params;
  logEvent({
    event: "upstream_request_started",
    timestamp: new Date().toISOString(),
    requestId: context.requestId,
    routePath: route.path,
    cluster: route.cluster,
    provider: route.provider,
    surface: route.surface,
    method: route.method,
    wallet: verification.payer,
    paymentNetwork: config.paymentNetwork,
    paymentAsset: config.usdcMint,
    priceUsd: config.priceUsd
  });

  let upstreamResult;
  const upstreamStartedAt = Date.now();
  try {
    upstreamResult = await forwardToUpstream(config, route, params);
  } catch (error) {
    const latency = Date.now() - upstreamStartedAt;
    logEvent({
      event: "upstream_request_failed",
      timestamp: new Date().toISOString(),
      requestId: context.requestId,
      routePath: route.path,
      cluster: route.cluster,
      provider: route.provider,
      surface: route.surface,
      method: route.method,
      wallet: verification.payer,
      paymentNetwork: config.paymentNetwork,
      paymentAsset: config.usdcMint,
      priceUsd: config.priceUsd,
      upstreamLatencyMs: latency,
      httpStatus: 502,
      detail: {
        error: error instanceof Error ? error.message : "upstream_failed",
        settlementTransaction: settlement.transaction
      }
    });
    sendJson(
      response,
      502,
      {
        ok: false,
        error: "upstream_request_failed",
        paymentSettled: true,
        settlementTransaction: settlement.transaction
      },
      {
        [facilitator.getHeaders().paymentResponse]: facilitator.encodeSettlementResponse(settlement)
      }
    );
    return;
  }

  const upstreamLatencyMs = Date.now() - upstreamStartedAt;
  logEvent({
    event: "upstream_request_succeeded",
    timestamp: new Date().toISOString(),
    requestId: context.requestId,
    routePath: route.path,
    cluster: route.cluster,
    provider: route.provider,
    surface: route.surface,
    method: route.method,
    wallet: verification.payer,
    paymentNetwork: config.paymentNetwork,
    paymentAsset: config.usdcMint,
    priceUsd: config.priceUsd,
    upstreamLatencyMs,
    httpStatus: upstreamResult.status
  });

  logEvent({
    event: "usage_recorded",
    timestamp: new Date().toISOString(),
    requestId: context.requestId,
    routePath: route.path,
    cluster: route.cluster,
    provider: route.provider,
    surface: route.surface,
    method: route.method,
    wallet: settlement.payer,
    paymentNetwork: config.paymentNetwork,
    paymentAsset: config.usdcMint,
    priceUsd: config.priceUsd,
    upstreamLatencyMs,
    httpStatus: 200
  });

  sendJson(
    response,
    200,
    {
      ok: true,
      provider: route.provider,
      cluster: route.cluster,
      surface: route.surface,
      method: route.method,
      priceUsd: config.priceUsd,
      paymentNetwork: config.paymentNetwork,
      result: upstreamResult.result
    },
    {
      [facilitator.getHeaders().paymentResponse]: facilitator.encodeSettlementResponse(settlement)
    }
  );
}

const server = createServer(async (request, response) => {
  const context = createRequestContext();
  const url = requestUrl(request);

  try {
    if (request.method === "GET" && url.pathname === "/healthz") {
      sendJson(response, 200, { ok: true, service: "agon-gateway", status: "healthy" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/catalog") {
      sendJson(response, 200, {
        ok: true,
        version: 1,
        payment: facilitator.getSupportedDescriptor(),
        routes: catalog
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/facilitator/supported") {
      sendJson(response, 200, {
        ok: true,
        facilitator: facilitator.getSupportedDescriptor(),
        headers: facilitator.getHeaders()
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/facilitator/verify") {
      const body = await readJsonBody(request);
      const routePath = typeof (body as Record<string, unknown>).routePath === "string"
        ? ((body as Record<string, unknown>).routePath as string)
        : "";
      const route = routeMap.get(routePath);
      if (!route) {
        sendJson(response, 400, { ok: false, error: "Unknown routePath." });
        return;
      }
      const paymentPayload = (body as Record<string, unknown>).paymentPayload ?? body;
      sendJson(response, 200, {
        ok: true,
        verification: facilitator.verify(route, paymentPayload)
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/facilitator/settle") {
      if (!requireInternalSettlementAuth(request)) {
        sendJson(response, 403, { ok: false, error: "Forbidden." });
        return;
      }

      const body = await readJsonBody(request);
      const routePath = typeof (body as Record<string, unknown>).routePath === "string"
        ? ((body as Record<string, unknown>).routePath as string)
        : "";
      const route = routeMap.get(routePath);
      if (!route) {
        sendJson(response, 400, { ok: false, error: "Unknown routePath." });
        return;
      }
      const paymentPayload = (body as Record<string, unknown>).paymentPayload ?? body;
      const settlement = await facilitator.settle(route, paymentPayload);
      sendJson(response, settlement.success ? 200 : 400, {
        ok: settlement.success,
        settlement
      });
      return;
    }

    const matchedRoute = routeMap.get(url.pathname);
    if (matchedRoute) {
      await handlePaidRoute(request, response, context, matchedRoute);
      return;
    }

    sendJson(response, 404, { ok: false, error: "Not found." });
  } catch (error) {
    logEvent({
      event: "request_failed",
      timestamp: new Date().toISOString(),
      requestId: context.requestId,
      httpStatus: 500,
      detail: { error: error instanceof Error ? error.message : "unexpected_error" }
    });
    sendJson(response, 500, { ok: false, error: "Internal server error." });
  }
});

server.listen(config.port, () => {
  logEvent({
    event: "gateway_started",
    timestamp: new Date().toISOString(),
    requestId: "bootstrap",
    httpStatus: 200,
    detail: {
      port: config.port,
      routes: catalog.length,
      baseUrl: config.baseUrl,
      eventLogPath: config.eventLogPath
    }
  });
});
