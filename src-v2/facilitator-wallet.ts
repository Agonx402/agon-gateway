import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import type { GatewayConfig } from "./types";

function parseWalletBytes(raw: string): Uint8Array {
  const parsed = JSON.parse(raw) as number[];
  if (!Array.isArray(parsed) || parsed.length !== 64) {
    throw new Error("Facilitator wallet must be a 64-byte Solana keypair JSON array.");
  }
  return Uint8Array.from(parsed);
}

export async function loadFacilitatorSigner(config: GatewayConfig) {
  if (config.facilitatorWalletBase64) {
    const decoded = Buffer.from(config.facilitatorWalletBase64, "base64").toString("utf8");
    return createKeyPairSignerFromBytes(parseWalletBytes(decoded));
  }

  if (!config.facilitatorWalletPath) {
    throw new Error("Missing facilitator wallet configuration. Set AGON_FACILITATOR_WALLET_B64 or AGON_FACILITATOR_WALLET_PATH.");
  }

  const raw = readFileSync(config.facilitatorWalletPath, "utf8");
  return createKeyPairSignerFromBytes(parseWalletBytes(raw));
}
