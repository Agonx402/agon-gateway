import { handleHealthRequest } from "../../src-v2/x402-runtime";

export const runtime = "nodejs";
export const preferredRegion = "iad1";
export const maxDuration = 60;

export async function GET() {
  return handleHealthRequest();
}
