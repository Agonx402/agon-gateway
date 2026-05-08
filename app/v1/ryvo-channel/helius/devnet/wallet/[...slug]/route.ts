import type { NextRequest } from "next/server";
import { handleRyvoChannelRouteOptionsRequest, handleRyvoChannelRouteRequest } from "../../../../../../../src-v2/x402-runtime";

export const runtime = "nodejs";
export const preferredRegion = "iad1";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  return handleRyvoChannelRouteRequest(request);
}

export async function POST(request: NextRequest) {
  return handleRyvoChannelRouteRequest(request);
}

export async function HEAD(request: NextRequest) {
  return handleRyvoChannelRouteRequest(request);
}

export async function OPTIONS(request: NextRequest) {
  return handleRyvoChannelRouteOptionsRequest(request);
}
