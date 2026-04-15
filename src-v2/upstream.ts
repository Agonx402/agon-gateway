import type { GatewayConfig, RouteSpec, UpstreamResult } from "./types";

function pickUpstreamUrl(config: GatewayConfig, route: RouteSpec): string {
  if (route.provider === "alchemy") {
    return route.cluster === "mainnet"
      ? config.alchemyMainnetRpcUrl
      : config.alchemyDevnetRpcUrl;
  }

  return route.cluster === "mainnet"
    ? config.heliusMainnetRpcUrl
    : config.heliusDevnetRpcUrl;
}

export async function forwardToUpstream(
  config: GatewayConfig,
  route: RouteSpec,
  params: unknown,
): Promise<UpstreamResult> {
  const upstreamUrl = pickUpstreamUrl(config, route);

  const rpcBody = {
    jsonrpc: "2.0",
    id: 1,
    method: route.method,
    params,
  };

  const response = await fetch(upstreamUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(rpcBody),
  });

  const rawText = await response.text();
  let parsed: unknown = null;

  try {
    parsed = rawText.length === 0 ? null : JSON.parse(rawText);
  } catch {
    throw new Error(`Upstream returned non-JSON response with status ${response.status}.`);
  }

  if (!response.ok) {
    throw new Error(`Upstream returned status ${response.status}.`);
  }

  if (
    parsed !== null &&
    typeof parsed === "object" &&
    "error" in parsed &&
    (parsed as { error?: unknown }).error !== undefined
  ) {
    throw new Error(`Upstream JSON-RPC error for ${route.method}.`);
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
