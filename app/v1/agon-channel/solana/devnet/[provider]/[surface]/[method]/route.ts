import type { NextRequest } from "next/server";
import { handleAgonChannelRouteOptionsRequest, handleAgonChannelRouteRequest } from "../../../../../../../../src-v2/x402-runtime";

export const runtime = "nodejs";
export const preferredRegion = "iad1";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  return handleAgonChannelRouteRequest(request);
}

export async function POST(request: NextRequest) {
  return handleAgonChannelRouteRequest(request);
}

export async function HEAD(request: NextRequest) {
  return handleAgonChannelRouteRequest(request);
}

export async function OPTIONS(request: NextRequest) {
  return handleAgonChannelRouteOptionsRequest(request);
}
