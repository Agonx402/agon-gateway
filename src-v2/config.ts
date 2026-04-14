import { existsSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import type { GatewayConfig } from "./types.js";

dotenv.config();

for (const candidate of [".env.local", ".env"]) {
  const fullPath = resolve(process.cwd(), candidate);
  if (existsSync(fullPath)) {
    dotenv.config({ path: fullPath, override: true });
  }
}

const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function readString(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function readNumber(name: string, fallback?: string): number {
  const raw = readString(name, fallback);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number.`);
  }
  return parsed;
}

function readBigInt(name: string, fallback?: string): bigint {
  const raw = readString(name, fallback);
  try {
    const parsed = BigInt(raw);
    if (parsed <= 0n) {
      throw new Error("non-positive");
    }
    return parsed;
  } catch {
    throw new Error(`Environment variable ${name} must be a positive integer string.`);
  }
}

export function loadConfig(): GatewayConfig {
  return {
    port: readNumber("PORT", "8080"),
    baseUrl: readString("AGON_GATEWAY_BASE_URL", "http://localhost:8080"),
    eventLogPath: readString("AGON_GATEWAY_EVENT_LOG_PATH", ".data/events.ndjson"),
    facilitatorWalletPath: readString("AGON_FACILITATOR_WALLET_PATH", process.env.AGON_OPERATOR_WALLET_PATH),
    internalSettlementSecret: readString("AGON_INTERNAL_SETTLEMENT_SECRET"),
    payToWallet: readString("AGON_X402_PAY_TO_WALLET", process.env.AGON_GATEWAY_PAYEE_WALLET),
    usdcMint: readString("AGON_X402_USDC_MINT", MAINNET_USDC_MINT),
    priceUsd: readString("AGON_X402_PRICE_USD", "0.01"),
    priceAtomic: readBigInt("AGON_X402_PRICE_ATOMIC", "10000"),
    paymentNetwork: SOLANA_MAINNET_CAIP2,
    paymentAssetSymbol: "USDC",
    paymentAssetDecimals: 6,
    solanaMainnetRpcUrl: readString("SOLANA_MAINNET_RPC_URL", "https://api.mainnet-beta.solana.com"),
    alchemyMainnetRpcUrl: readString("ALCHEMY_MAINNET_RPC_URL"),
    alchemyDevnetRpcUrl: readString("ALCHEMY_DEVNET_RPC_URL"),
    heliusMainnetRpcUrl: readString("HELIUS_MAINNET_RPC_URL"),
    heliusDevnetRpcUrl: readString("HELIUS_DEVNET_RPC_URL"),
    rpcRateLimitPerSecond: readNumber("AGON_RATE_LIMIT_RPC_RPS", "50"),
    dasRateLimitPerSecond: readNumber("AGON_RATE_LIMIT_DAS_RPS", "10"),
    challengeRateLimitPerMinute: readNumber("AGON_RATE_LIMIT_CHALLENGE_PER_MINUTE", "120")
  };
}
