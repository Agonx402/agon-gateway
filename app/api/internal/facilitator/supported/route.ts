import type { NextRequest } from "next/server";
import { handleFacilitatorSupportedRequest, requireInternalAuth } from "../../../../../src-v2/x402-runtime";

export const runtime = "nodejs";
export const preferredRegion = "iad1";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const authFailure = await requireInternalAuth(request);
  if (authFailure) {
    return authFailure;
  }

  return handleFacilitatorSupportedRequest();
}
