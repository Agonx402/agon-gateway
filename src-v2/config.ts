import { existsSync, readFileSync } from "node:fs";
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

function readOptionalNumber(name: string, fallback?: string): number | undefined {
  const value = readOptionalString(name, fallback);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number.`);
  }
  return parsed;
}

function readPositiveInteger(name: string, fallback?: string): number {
  const parsed = readNumber(name, fallback);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer.`);
  }
  return parsed;
}

function readOptionalPositiveInteger(name: string, fallback?: string): number | undefined {
  const parsed = readOptionalNumber(name, fallback);
  if (parsed === undefined) {
    return undefined;
  }
  if (!Number.isInteger(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer.`);
  }
  return parsed;
}

function readOptionalU16(name: string): number | undefined {
  const value = readOptionalString(name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`Environment variable ${name} must be an integer between 0 and 65535.`);
  }
  return parsed;
}

function readDevnetDeploymentTokenId(): number | undefined {
  const configPath = readOptionalString("AGON_PROTOCOL_DEVNET_DEPLOYMENT_CONFIG");
  if (!configPath || !existsSync(configPath)) {
    return undefined;
  }

  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
    tokens?: Array<{ id?: number; tokenId?: number; mint?: string }>;
  };
  const token = parsed.tokens?.find((entry) => entry.mint === DEVNET_USDC_MINT);
  const tokenId = token?.id ?? token?.tokenId;
  if (tokenId === undefined) {
    return undefined;
  }
  if (!Number.isInteger(tokenId) || tokenId < 0 || tokenId > 65_535) {
    throw new Error("Devnet deployment config contains an invalid USDC token ID.");
  }
  return tokenId;
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
      ].join(" "),
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
  const agonProtocolDevnetUsdcTokenId = readOptionalU16(
    "AGON_PROTOCOL_DEVNET_USDC_TOKEN_ID",
  ) ?? readDevnetDeploymentTokenId();

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
    upstashRedisRestToken: readString("UPSTASH_REDIS_REST_TOKEN"),
    agonProtocolProgramId: readOptionalString("AGON_PROTOCOL_PROGRAM_ID"),
    agonProtocolDevnetUsdcTokenId,
    agonMerchantOwner: readOptionalString("AGON_GATEWAY_MERCHANT_OWNER"),
    agonMerchantParticipantId: readOptionalPositiveInteger("AGON_GATEWAY_MERCHANT_PARTICIPANT_ID"),
    agonMessageVersion: readPositiveInteger("AGON_PROTOCOL_MESSAGE_VERSION", "1"),
    agonChainId: readPositiveInteger("AGON_PROTOCOL_DEVNET_CHAIN_ID", "1"),
    agonChannelSnapshotTtlMs: readPositiveInteger("AGON_CHANNEL_SNAPSHOT_TTL_MS", "2000"),
    agonChannelSettlementMinDelta: readString("AGON_CHANNEL_SETTLEMENT_MIN_DELTA", "0.250000"),
    agonChannelSettlementMaxAgeSeconds: readPositiveInteger("AGON_CHANNEL_SETTLEMENT_MAX_AGE_SECONDS", "300"),
    agonChannelSettlementMinHeadroomBps: readPositiveInteger("AGON_CHANNEL_SETTLEMENT_MIN_HEADROOM_BPS", "1000"),
  };
}
