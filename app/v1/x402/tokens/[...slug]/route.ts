import type { NextRequest } from "next/server";
import { handlePaidRouteRequest } from "../../../../../src-v2/x402-runtime";

export const runtime = "nodejs";
export const preferredRegion = "iad1";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  return handlePaidRouteRequest(request);
}

export async function POST(request: NextRequest) {
  return handlePaidRouteRequest(request);
}
