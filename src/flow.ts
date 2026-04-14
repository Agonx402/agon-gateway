import type { GatewayDecision, GatewayRpcRequestContext } from "./types.js";

export function evaluateGatewayPreconditions(
  context: GatewayRpcRequestContext
): GatewayDecision {
  if (context.payerId === undefined) {
    return {
      allow: false,
      code: "missing-participant",
      reason: "User is not registered as an Agon participant yet.",
    };
  }

  if (context.settledCumulative === undefined) {
    return {
      allow: false,
      code: "missing-channel",
      reason: "No payment lane exists between the caller and Agon Gateway.",
    };
  }

  if ((context.lockedBalance ?? 0n) <= 0n) {
    return {
      allow: false,
      code: "missing-locked-funds",
      reason: "The payment lane exists but no funds are locked for request streaming.",
    };
  }

  if (
    context.committedAmount === undefined ||
    context.previousAcceptedCumulative === undefined ||
    context.requestedPrice === undefined
  ) {
    return {
      allow: false,
      code: "insufficient-commitment",
      reason: "The request is missing cumulative payment state needed for verification.",
    };
  }

  if (context.committedAmount <= context.previousAcceptedCumulative) {
    return {
      allow: false,
      code: "non-monotonic-commitment",
      reason: "Committed amount must strictly increase on every paid RPC call.",
    };
  }

  const expectedMinimum =
    context.previousAcceptedCumulative + context.requestedPrice;
  if (context.committedAmount < expectedMinimum) {
    return {
      allow: false,
      code: "insufficient-commitment",
      reason: "Committed amount does not cover the priced RPC request.",
    };
  }

  if (context.settledCumulative === undefined) {
    return {
      allow: false,
      code: "missing-channel",
      reason: "The gateway could not determine the on-chain settled state for this lane.",
    };
  }

  const outstandingExposure = context.committedAmount - context.settledCumulative;
  if (outstandingExposure > (context.lockedBalance ?? 0n)) {
    return {
      allow: false,
      code: "insufficient-locked-funds",
      reason: "The requested cumulative amount exceeds the lane's currently locked funds.",
    };
  }

  return {
    allow: true,
    code: "ok",
    reason: "Request is payable and may be forwarded upstream.",
  };
}
