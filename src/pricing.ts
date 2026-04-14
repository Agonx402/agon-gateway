import type { RpcMethodPrice } from "./types.js";

export const DEFAULT_RPC_PRICING: RpcMethodPrice[] = [
  {
    method: "getBalance",
    microAgonPrice: 1,
    description: "Standard read call",
  },
  {
    method: "getAccountInfo",
    microAgonPrice: 1,
    description: "Standard account read",
  },
  {
    method: "getLatestBlockhash",
    microAgonPrice: 1,
    description: "Low-cost chain metadata",
  },
  {
    method: "getProgramAccounts",
    microAgonPrice: 10,
    description: "Expensive indexed scan",
  },
  {
    method: "sendTransaction",
    microAgonPrice: 25,
    description: "Premium write path",
  },
];

const DEFAULT_METHOD_PRICE = 1;

export function getMicroAgonPriceForMethod(
  method: string,
  pricingTable: RpcMethodPrice[] = DEFAULT_RPC_PRICING
): number {
  const normalizedMethod = method.trim();
  return (
    pricingTable.find((entry) => entry.method === normalizedMethod)
      ?.microAgonPrice ?? DEFAULT_METHOD_PRICE
  );
}
