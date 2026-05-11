import { type NextRequest, NextResponse } from "next/server";
import { runSettlementCycle } from "../../../../../src-v2/settler";

export const runtime = "nodejs";
export const preferredRegion = "iad1";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

function isAuthorized(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const internalSecret = process.env.RYVO_INTERNAL_SETTLEMENT_SECRET;

  const authHeader = request.headers.get("authorization");
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    return true;
  }

  const internalHeader = request.headers.get("x-ryvo-internal-secret");
  if (internalSecret && internalHeader === internalSecret) {
    return true;
  }

  return false;
}

async function handle(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
  }

  const url = new URL(request.url);
  const dryRunOverride = url.searchParams.get("dryRun");
  const overrides = dryRunOverride !== null
    ? { ryvoSettlerDryRun: dryRunOverride === "1" || dryRunOverride === "true" }
    : undefined;

  try {
    const summary = await runSettlementCycle(overrides);
    return NextResponse.json({ ok: true, summary });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "settler_run_failed",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

// Vercel Cron sends GET requests by default. Accept both so manual runs
// (POST) and cron triggers (GET) share a single handler.
export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
