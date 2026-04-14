import type { IncomingMessage, ServerResponse } from "node:http";

export async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw) as T;
}

export function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown
): void {
  const payload = JSON.stringify(
    body,
    (_, value) => (typeof value === "bigint" ? value.toString() : value),
    2
  );
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(payload);
}

export function notFound(response: ServerResponse): void {
  sendJson(response, 404, {
    ok: false,
    code: "not-found",
    reason: "Route not found.",
  });
}
