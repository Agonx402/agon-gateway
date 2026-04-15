import bs58 from "bs58";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import type { GatewayConfig } from "./types";

function parseBase58WalletBytes(raw: string): Uint8Array {
  try {
    const decoded = bs58.decode(raw.trim());
    if (decoded.length !== 64) {
      throw new Error("wrong_length");
    }
    return decoded;
  } catch {
    throw new Error("Facilitator wallet must be a base58-encoded 64-byte Solana secret key.");
  }
}

export async function loadFacilitatorSigner(config: GatewayConfig) {
  return createKeyPairSignerFromBytes(parseBase58WalletBytes(config.facilitatorWalletBase58));
}
