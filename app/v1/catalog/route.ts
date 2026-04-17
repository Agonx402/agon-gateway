import type { NextRequest } from "next/server";
import { handleCatalogRequest, handleOptionsRequest } from "../../../src-v2/x402-runtime";

export const runtime = "nodejs";
export const preferredRegion = "iad1";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  return handleCatalogRequest(request);
}

export async function HEAD(request: NextRequest) {
  return handleCatalogRequest(request);
}

export function OPTIONS() {
  return handleOptionsRequest(["GET", "HEAD", "OPTIONS"]);
}
