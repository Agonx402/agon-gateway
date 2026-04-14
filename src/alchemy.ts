import type { RpcGatewayRequestBody } from "./contracts.js";

export async function forwardRpcToAlchemy(params: {
  alchemySolanaRpcUrl: string;
  requestBody: RpcGatewayRequestBody;
}): Promise<unknown> {
  const upstreamResponse = await fetch(params.alchemySolanaRpcUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: params.requestBody.method,
      params: params.requestBody.params,
    }),
  });

  const payload = (await upstreamResponse.json()) as {
    result?: unknown;
    error?: unknown;
  };

  if (!upstreamResponse.ok) {
    throw new Error(
      `Alchemy upstream request failed with status ${upstreamResponse.status}`
    );
  }

  if (payload.error !== undefined) {
    return { error: payload.error };
  }

  return payload.result;
}
