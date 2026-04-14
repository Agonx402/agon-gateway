import fs from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";

for (const [fileName, override] of [
  [".env", false],
  [".env.local", true],
] as const) {
  const envPath = path.resolve(process.cwd(), fileName);
  if (fs.existsSync(envPath)) {
    loadDotenv({ path: envPath, override });
  }
}

export interface GatewayConfig {
  port: number;
  alchemySolanaRpcUrl: string;
  agonRpcUrl: string;
  agonProgramId: string;
  agonMessageDomainHex: string;
  gatewayPayeeWallet: string;
  gatewayPayeeId: number;
  tokenId: number;
  tokenSymbol: string;
  tokenMint?: string;
  storagePath: string;
  requireSignatureHex: boolean;
  operatorWalletPath?: string;
  topUpDefaultUnits: bigint;
  topUpBonusSolLamports: bigint;
  topUpQuoteTtlSeconds: number;
}

function parseNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric env ${name}=${raw}`);
  }
  return parsed;
}

function resolveAlchemySolanaRpcUrl(): string {
  const directUrl = process.env.ALCHEMY_SOLANA_RPC_URL?.trim();
  if (directUrl) return directUrl;

  const apiKey = process.env.ALCHEMY_API_KEY?.trim();
  const network = process.env.ALCHEMY_SOLANA_NETWORK?.trim() || "solana-devnet";
  if (apiKey) {
    return `https://${network}.g.alchemy.com/v2/${apiKey}`;
  }

  throw new Error(
    "Missing Alchemy config. Set ALCHEMY_SOLANA_RPC_URL or ALCHEMY_API_KEY."
  );
}

function parseOptionalStringEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

function parseBigIntEnv(name: string, fallback: bigint): bigint {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  try {
    return BigInt(raw);
  } catch {
    throw new Error(`Invalid bigint env ${name}=${raw}`);
  }
}

function requireStringEnv(name: string): string {
  const raw = parseOptionalStringEnv(name);
  if (!raw) {
    throw new Error(`Missing required env ${name}`);
  }
  return raw;
}

export function loadGatewayConfig(): GatewayConfig {
  const storagePath =
    process.env.AGON_GATEWAY_STORAGE_PATH?.trim() ||
    path.resolve(process.cwd(), ".data", "gateway-state.json");

  return {
    port: parseNumberEnv("PORT", 8787),
    alchemySolanaRpcUrl: resolveAlchemySolanaRpcUrl(),
    agonRpcUrl:
      parseOptionalStringEnv("AGON_RPC_URL") ?? "https://api.devnet.solana.com",
    agonProgramId: requireStringEnv("AGON_PROGRAM_ID"),
    agonMessageDomainHex: requireStringEnv("AGON_MESSAGE_DOMAIN_HEX"),
    gatewayPayeeWallet: requireStringEnv("AGON_GATEWAY_PAYEE_WALLET"),
    gatewayPayeeId: parseNumberEnv("AGON_GATEWAY_PAYEE_ID", 9999),
    tokenId: parseNumberEnv("AGON_GATEWAY_TOKEN_ID", 2),
    tokenSymbol: parseOptionalStringEnv("AGON_GATEWAY_TOKEN_SYMBOL") ?? "aUSDC",
    tokenMint:
      parseOptionalStringEnv("AGON_GATEWAY_TOKEN_MINT") ??
      "AMXvvKksfCprEKY9uxzNx9MKrDq9kwDWG6Fr9sXkEpAr",
    storagePath,
    requireSignatureHex:
      (process.env.AGON_REQUIRE_SIGNATURE_HEX ?? "1").trim() !== "0",
    operatorWalletPath: parseOptionalStringEnv("AGON_OPERATOR_WALLET_PATH"),
    topUpDefaultUnits: parseBigIntEnv(
      "AGON_TOPUP_DEFAULT_UNITS",
      25_000_000n
    ),
    topUpBonusSolLamports: parseBigIntEnv(
      "AGON_TOPUP_BONUS_SOL_LAMPORTS",
      50_000_000n
    ),
    topUpQuoteTtlSeconds: parseNumberEnv("AGON_TOPUP_QUOTE_TTL_SECONDS", 900),
  };
}
