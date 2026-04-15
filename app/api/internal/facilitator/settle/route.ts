import type { NextRequest } from "next/server";
import { handleFacilitatorSettleRequest, requireInternalAuth } from "../../../../../src-v2/x402-runtime";

export const runtime = "nodejs";
export const preferredRegion = "iad1";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const authFailure = await requireInternalAuth(request);
  if (authFailure) {
    return authFailure;
  }

  return handleFacilitatorSettleRequest(request);
}
