import { existsSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import type { GatewayConfig } from "./types";

dotenv.config();

for (const candidate of [".env.local", ".env"]) {
  const fullPath = resolve(process.cwd(), candidate);
  if (existsSync(fullPath)) {
    dotenv.config({ path: fullPath, override: true });
  }
}

const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

function readOptionalString(name: string, fallback?: string): string | undefined {
  const value = process.env[name] ?? fallback;
  if (!value || value.trim().length === 0) {
    return undefined;
  }
  return value.trim();
}

function readString(name: string, fallback?: string): string {
  const value = readOptionalString(name, fallback);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readNumber(name: string, fallback?: string): number {
  const raw = readString(name, fallback);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number.`);
  }
  return parsed;
}

function assertUsdcMint(
  usdcMint: string,
  expectedMint: string,
  envName: string,
  networkLabel: "mainnet" | "devnet",
): string {
  if (usdcMint !== expectedMint) {
    throw new Error(
      [
        `Invalid ${envName}.`,
        `Expected ${networkLabel} USDC mint (${expectedMint})`,
        `but received (${usdcMint}).`,
        `This gateway only supports canonical ${networkLabel} USDC settlement.`,
      ].join(" ")
    );
  }
  return usdcMint;
}

export function loadConfig(): GatewayConfig {
  const vercelUrl = readOptionalString("VERCEL_URL");
  const baseUrlFallback = vercelUrl ? `https://${vercelUrl}` : "http://localhost:8080";
  const mainnetUsdcMint = assertUsdcMint(
    readString("AGON_X402_MAINNET_USDC_MINT", MAINNET_USDC_MINT),
    MAINNET_USDC_MINT,
    "AGON_X402_MAINNET_USDC_MINT",
    "mainnet",
  );
  const devnetUsdcMint = assertUsdcMint(
    readString("AGON_X402_DEVNET_USDC_MINT", DEVNET_USDC_MINT),
    DEVNET_USDC_MINT,
    "AGON_X402_DEVNET_USDC_MINT",
    "devnet",
  );

  return {
    port: readNumber("PORT", "8080"),
    baseUrl: readString("AGON_GATEWAY_BASE_URL", baseUrlFallback),
    facilitatorWalletBase58: readOptionalString("AGON_FACILITATOR_WALLET_BASE58"),
    internalSettlementSecret: readOptionalString("AGON_INTERNAL_SETTLEMENT_SECRET"),
    payToWallet: readString("AGON_X402_PAY_TO_WALLET", process.env.AGON_GATEWAY_PAYEE_WALLET),
    mainnetUsdcMint,
    devnetUsdcMint,
    mainnetPaymentNetwork: SOLANA_MAINNET_CAIP2,
    devnetPaymentNetwork: SOLANA_DEVNET_CAIP2,
    paymentAssetSymbol: "USDC",
    paymentAssetDecimals: 6,
    solanaMainnetRpcUrl: readString("SOLANA_MAINNET_RPC_URL", "https://api.mainnet-beta.solana.com"),
    solanaDevnetRpcUrl: readString("SOLANA_DEVNET_RPC_URL", "https://api.devnet.solana.com"),
    alchemyMainnetRpcUrl: readString("ALCHEMY_MAINNET_RPC_URL"),
    alchemyDevnetRpcUrl: readString("ALCHEMY_DEVNET_RPC_URL"),
    heliusMainnetRpcUrl: readString("HELIUS_MAINNET_RPC_URL"),
    heliusDevnetRpcUrl: readString("HELIUS_DEVNET_RPC_URL"),
    heliusApiKey: readString("HELIUS_API_KEY"),
    heliusWalletApiBaseUrl: readString("HELIUS_WALLET_API_BASE_URL", "https://api.helius.xyz"),
    tokensApiBaseUrl: readString("TOKENS_API_BASE_URL", "https://api.tokens.xyz"),
    tokensApiKey: readString("TOKENS_API_KEY"),
    rpcRateLimitPerSecond: readNumber("AGON_RATE_LIMIT_RPC_RPS", "50"),
    dasRateLimitPerSecond: readNumber("AGON_RATE_LIMIT_DAS_RPS", "10"),
    tokensRateLimitPerMinute: readNumber("AGON_RATE_LIMIT_TOKENS_PER_MINUTE", "30"),
    challengeRateLimitPerMinute: readNumber("AGON_RATE_LIMIT_CHALLENGE_PER_MINUTE", "120"),
    upstashRedisRestUrl: readString("UPSTASH_REDIS_REST_URL"),
    upstashRedisRestToken: readString("UPSTASH_REDIS_REST_TOKEN")
  };
}
