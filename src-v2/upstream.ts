import type { GatewayConfig, ResolvedRoute, RouteSpec, UpstreamResult } from "./types";

export class UpstreamHttpError extends Error {
  public readonly status: number;
  public readonly body: unknown;
  public readonly exposeBody: boolean;

  public constructor(message: string, status: number, body: unknown, exposeBody = false) {
    super(message);
    this.status = status;
    this.body = body;
    this.exposeBody = exposeBody;
  }
}

function pickSolanaUpstreamUrl(config: GatewayConfig, route: RouteSpec): string {
  if (route.provider === "alchemy") {
    return route.cluster === "mainnet"
      ? config.alchemyMainnetRpcUrl
      : config.alchemyDevnetRpcUrl;
  }

  return route.cluster === "mainnet"
    ? config.heliusMainnetRpcUrl
    : config.heliusDevnetRpcUrl;
}

function replacePathParams(template: string, pathParams: Record<string, string>): string {
  return Object.entries(pathParams).reduce(
    (current, [key, value]) => current.replaceAll(`:${key}`, encodeURIComponent(value)),
    template,
  );
}

async function parseUpstreamResponse(response: Response): Promise<unknown> {
  const rawText = await response.text();
  if (rawText.length === 0) {
    return null;
  }

  try {
    return JSON.parse(rawText);
  } catch {
    return rawText;
  }
}

async function forwardSolanaRequest(
  config: GatewayConfig,
  resolvedRoute: ResolvedRoute,
  params: unknown,
): Promise<UpstreamResult> {
  const upstreamUrl = pickSolanaUpstreamUrl(config, resolvedRoute.route);
  const rpcBody = {
    jsonrpc: "2.0",
    id: 1,
    method: resolvedRoute.route.method,
    params,
  };

  const response = await fetch(upstreamUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(rpcBody),
  });

  const parsed = await parseUpstreamResponse(response);
  if (!response.ok) {
    throw new UpstreamHttpError(
      `Upstream returned status ${response.status}.`,
      502,
      parsed,
      false,
    );
  }

  if (
    parsed !== null
    && typeof parsed === "object"
    && "error" in parsed
    && (parsed as { error?: unknown }).error !== undefined
  ) {
    throw new UpstreamHttpError(
      `Upstream JSON-RPC error for ${resolvedRoute.route.method}.`,
      502,
      parsed,
      false,
    );
  }

  if (parsed !== null && typeof parsed === "object" && "result" in parsed) {
    return {
      result: (parsed as { result: unknown }).result,
      status: response.status,
    };
  }

  return {
    result: parsed,
    status: response.status,
  };
}

async function forwardTokensRequest(
  config: GatewayConfig,
  resolvedRoute: ResolvedRoute,
  params: unknown,
): Promise<UpstreamResult> {
  const upstreamPath = replacePathParams(resolvedRoute.route.upstreamPath, resolvedRoute.pathParams);
  const upstreamUrl = new URL(upstreamPath, config.tokensApiBaseUrl.endsWith("/") ? config.tokensApiBaseUrl : `${config.tokensApiBaseUrl}/`);
  const headers = new Headers();

  if (resolvedRoute.route.requiresUpstreamAuth) {
    headers.set("x-api-key", config.tokensApiKey);
  }

  let body: string | undefined;
  if (resolvedRoute.route.inputMode === "query") {
    if (!(params instanceof URLSearchParams)) {
      throw new Error("Tokens query routes must forward URLSearchParams.");
    }
    const query = params.toString();
    if (query.length > 0) {
      upstreamUrl.search = query;
    }
  } else {
    headers.set("content-type", "application/json");
    body = JSON.stringify(params);
  }

  const response = await fetch(upstreamUrl, {
    method: resolvedRoute.route.httpMethod,
    headers,
    body,
  });

  const parsed = await parseUpstreamResponse(response);
  if (!response.ok) {
    throw new UpstreamHttpError(
      `Tokens API returned status ${response.status}.`,
      response.status,
      parsed,
      true,
    );
  }

  return {
    result: parsed,
    status: response.status,
  };
}

export async function forwardToUpstream(
  config: GatewayConfig,
  resolvedRoute: ResolvedRoute,
  params: unknown,
): Promise<UpstreamResult> {
  if (resolvedRoute.route.provider === "tokens") {
    return forwardTokensRequest(config, resolvedRoute, params);
  }

  return forwardSolanaRequest(config, resolvedRoute, params);
}
