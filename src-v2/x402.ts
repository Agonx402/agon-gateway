import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import type {
  GatewayConfig,
  PaymentRequiredEnvelope,
  PaymentRequirement,
  RouteSpec,
  SettlementResponse,
  VerificationResult
} from "./types.js";

const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";
const TRANSFER_CHECKED_DISCRIMINATOR = 12;
const CACHE_TTL_MS = 120000;

function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function decodeBase64Json<T>(value: string): T {
  const decoded = Buffer.from(value, "base64").toString("utf8");
  return JSON.parse(decoded) as T;
}

function readKeypairFromFile(walletPath: string): Keypair {
  const raw = JSON.parse(readFileSync(walletPath, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function readU64LE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let index = 0; index < bytes.length; index += 1) {
    result += BigInt(bytes[index] ?? 0) << (8n * BigInt(index));
  }
  return result;
}

function isZeroSignature(signature: Uint8Array | null | undefined): boolean {
  if (!signature) {
    return true;
  }
  for (const byte of signature) {
    if (byte !== 0) {
      return false;
    }
  }
  return true;
}

function parseTransactionPayload(paymentPayload: unknown): string {
  const candidates: unknown[] = [];
  if (paymentPayload && typeof paymentPayload === "object") {
    const record = paymentPayload as Record<string, unknown>;
    candidates.push(
      record.transaction,
      record.tx,
      record.signedTransaction,
      record.paymentPayload,
      record.payload
    );

    if (record.payment && typeof record.payment === "object") {
      const nested = record.payment as Record<string, unknown>;
      candidates.push(nested.transaction, nested.tx, nested.signedTransaction);
    }
  }

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }

  throw new Error("Missing signed transaction in payment payload.");
}

function parseRequirementFromPayload(paymentPayload: unknown): Partial<PaymentRequirement> | undefined {
  if (!paymentPayload || typeof paymentPayload !== "object") {
    return undefined;
  }

  const record = paymentPayload as Record<string, unknown>;
  const candidates: unknown[] = [
    record.requirement,
    record.paymentRequirement,
    record.paymentRequirements
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      if (Array.isArray(candidate)) {
        const first = candidate[0];
        if (first && typeof first === "object") {
          return first as Partial<PaymentRequirement>;
        }
      } else {
        return candidate as Partial<PaymentRequirement>;
      }
    }
  }

  return undefined;
}

function decodeTransaction(transactionBase64: string): Transaction | VersionedTransaction {
  const raw = Buffer.from(transactionBase64, "base64");
  try {
    return VersionedTransaction.deserialize(raw);
  } catch {
    return Transaction.from(raw);
  }
}

function getFeePayer(transaction: Transaction | VersionedTransaction): PublicKey {
  if (transaction instanceof VersionedTransaction) {
    return transaction.message.staticAccountKeys[0];
  }

  if (transaction.feePayer) {
    return transaction.feePayer;
  }

  const firstSignature = transaction.signatures[0];
  if (!firstSignature) {
    throw new Error("Legacy transaction is missing a fee payer.");
  }
  return firstSignature.publicKey;
}

function hasNonFacilitatorSignature(
  transaction: Transaction | VersionedTransaction,
  facilitator: PublicKey
): boolean {
  if (transaction instanceof VersionedTransaction) {
    const signerCount = transaction.message.header.numRequiredSignatures;
    const signerKeys = transaction.message.staticAccountKeys.slice(0, signerCount);
    return signerKeys.some((signerKey, index) => {
      const signature = transaction.signatures[index];
      return !signerKey.equals(facilitator) && !isZeroSignature(signature);
    });
  }

  return transaction.signatures.some(
    (entry) => !entry.publicKey.equals(facilitator) && !isZeroSignature(entry.signature ?? undefined)
  );
}

function getInstructions(transaction: Transaction | VersionedTransaction) {
  if (transaction instanceof VersionedTransaction) {
    const message = TransactionMessage.decompile(transaction.message);
    return message.instructions;
  }

  return transaction.instructions;
}

function findUsdcTransferCheckedInstruction(
  transaction: Transaction | VersionedTransaction,
  usdcMint: PublicKey,
  destinationAta: PublicKey,
  expectedAtomicAmount: bigint
): { payer: string; amountAtomic: bigint } {
  const instructions = getInstructions(transaction);

  for (const instruction of instructions) {
    if (!instruction.programId.equals(TOKEN_PROGRAM_ID) && !instruction.programId.equals(TOKEN_2022_PROGRAM_ID)) {
      continue;
    }

    if (instruction.data.length < 10 || instruction.data[0] !== TRANSFER_CHECKED_DISCRIMINATOR) {
      continue;
    }

    const [source, mint, destination, owner] = instruction.keys;
    if (!source || !mint || !destination || !owner) {
      continue;
    }

    if (!mint.pubkey.equals(usdcMint)) {
      continue;
    }

    if (!destination.pubkey.equals(destinationAta)) {
      continue;
    }

    const amountAtomic = readU64LE(instruction.data.slice(1, 9));
    const decimals = instruction.data[9];

    if (decimals !== 6) {
      throw new Error("TransferChecked instruction does not use 6 decimals.");
    }

    if (amountAtomic !== expectedAtomicAmount) {
      throw new Error("TransferChecked amount does not match the route price.");
    }

    return {
      payer: owner.pubkey.toBase58(),
      amountAtomic
    };
  }

  throw new Error("No matching USDC TransferChecked instruction found.");
}

class SettlementCache {
  private readonly entries = new Map<string, number>();

  public has(key: string): boolean {
    this.prune();
    return this.entries.has(key);
  }

  public put(key: string): void {
    this.prune();
    this.entries.set(key, Date.now() + CACHE_TTL_MS);
  }

  public delete(key: string): void {
    this.entries.delete(key);
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.entries.entries()) {
      if (expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}

export class ExactSvmFacilitator {
  private readonly config: GatewayConfig;
  private readonly keypair: Keypair;
  private readonly connection: Connection;
  private readonly usdcMint: PublicKey;
  private readonly payTo: PublicKey;
  private readonly payToUsdcAta: PublicKey;
  private readonly settlementCache = new SettlementCache();

  public constructor(config: GatewayConfig) {
    this.config = config;
    this.keypair = readKeypairFromFile(config.facilitatorWalletPath);
    this.connection = new Connection(config.solanaMainnetRpcUrl, "confirmed");
    this.usdcMint = new PublicKey(config.usdcMint);
    this.payTo = new PublicKey(config.payToWallet);
    this.payToUsdcAta = getAssociatedTokenAddressSync(this.usdcMint, this.payTo, false, TOKEN_PROGRAM_ID);
  }

  public getHeaders() {
    return {
      paymentRequired: PAYMENT_REQUIRED_HEADER,
      paymentSignature: PAYMENT_SIGNATURE_HEADER,
      paymentResponse: PAYMENT_RESPONSE_HEADER
    };
  }

  public getSupportedDescriptor() {
    return {
      version: 2,
      scheme: "exact",
      network: this.config.paymentNetwork,
      asset: {
        symbol: this.config.paymentAssetSymbol,
        mint: this.config.usdcMint,
        decimals: this.config.paymentAssetDecimals
      },
      priceUsd: this.config.priceUsd,
      priceAtomic: this.config.priceAtomic.toString(),
      payTo: this.config.payToWallet,
      facilitator: `${this.config.baseUrl}/facilitator`
    };
  }

  public buildRequirement(route: RouteSpec): PaymentRequirement {
    return {
      scheme: "exact",
      network: this.config.paymentNetwork,
      maxAmountRequired: this.config.priceAtomic.toString(),
      resource: `${this.config.baseUrl}${route.path}`,
      description: route.description,
      mimeType: "application/json",
      payTo: this.config.payToWallet,
      asset: {
        address: this.config.usdcMint,
        symbol: this.config.paymentAssetSymbol,
        decimals: this.config.paymentAssetDecimals
      },
      facilitator: {
        url: `${this.config.baseUrl}/facilitator`
      },
      outputSchema: route.outputSchema,
      extensions: {
        bazaar: {
          type: "http",
          bodyType: "json",
          description: route.description,
          inputSchema: route.inputSchema,
          outputSchema: route.outputSchema
        }
      }
    };
  }

  public buildChallenge(route: RouteSpec): PaymentRequiredEnvelope {
    return {
      x402Version: 2,
      accepts: [this.buildRequirement(route)]
    };
  }

  public encodeChallenge(route: RouteSpec): string {
    return encodeBase64Json(this.buildChallenge(route));
  }

  public decodePaymentHeader(headerValue: string): unknown {
    return decodeBase64Json<unknown>(headerValue);
  }

  public encodeSettlementResponse(response: SettlementResponse): string {
    return encodeBase64Json(response);
  }

  public verify(route: RouteSpec, paymentPayload: unknown): VerificationResult {
    let transactionBase64: string;
    let parsedRequirement: Partial<PaymentRequirement> | undefined;

    try {
      transactionBase64 = parseTransactionPayload(paymentPayload);
      parsedRequirement = parseRequirementFromPayload(paymentPayload);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Invalid payment payload."
      };
    }

    const expectedRequirement = this.buildRequirement(route);

    if (parsedRequirement) {
      if (parsedRequirement.scheme && parsedRequirement.scheme !== expectedRequirement.scheme) {
        return { success: false, error: "Payment scheme does not match route requirement." };
      }
      if (parsedRequirement.network && parsedRequirement.network !== expectedRequirement.network) {
        return { success: false, error: "Payment network does not match route requirement." };
      }
      if (parsedRequirement.payTo && parsedRequirement.payTo !== expectedRequirement.payTo) {
        return { success: false, error: "Payment destination does not match route requirement." };
      }
      if (parsedRequirement.maxAmountRequired && parsedRequirement.maxAmountRequired !== expectedRequirement.maxAmountRequired) {
        return { success: false, error: "Payment amount does not match route requirement." };
      }
      const assetAddress = parsedRequirement.asset?.address;
      if (assetAddress && assetAddress !== expectedRequirement.asset.address) {
        return { success: false, error: "Payment asset does not match route requirement." };
      }
    }

    try {
      const transaction = decodeTransaction(transactionBase64);
      const facilitatorKey = this.keypair.publicKey;
      const feePayer = getFeePayer(transaction);

      if (!feePayer.equals(facilitatorKey)) {
        return { success: false, error: "Facilitator wallet is not the fee payer." };
      }

      if (!hasNonFacilitatorSignature(transaction, facilitatorKey)) {
        return { success: false, error: "Payment transaction is missing a buyer signature." };
      }

      const transfer = findUsdcTransferCheckedInstruction(
        transaction,
        this.usdcMint,
        this.payToUsdcAta,
        this.config.priceAtomic
      );

      return {
        success: true,
        payer: transfer.payer,
        amountAtomic: transfer.amountAtomic.toString(),
        settlementCacheKey: transactionBase64
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unable to verify payment."
      };
    }
  }

  public async settle(route: RouteSpec, paymentPayload: unknown): Promise<SettlementResponse> {
    const verification = this.verify(route, paymentPayload);
    if (!verification.success) {
      return {
        success: false,
        network: this.config.paymentNetwork,
        error: verification.error ?? "Payment verification failed."
      };
    }

    const cacheKey = verification.settlementCacheKey!;
    if (this.settlementCache.has(cacheKey)) {
      return {
        success: false,
        network: this.config.paymentNetwork,
        payer: verification.payer,
        error: "duplicate_settlement"
      };
    }

    this.settlementCache.put(cacheKey);

    try {
      const transactionBase64 = parseTransactionPayload(paymentPayload);
      const transaction = decodeTransaction(transactionBase64);

      if (transaction instanceof VersionedTransaction) {
        transaction.sign([this.keypair]);
        const signature = await this.connection.sendRawTransaction(transaction.serialize());
        await this.connection.confirmTransaction(signature, "confirmed");
        return {
          success: true,
          network: this.config.paymentNetwork,
          transaction: signature,
          payer: verification.payer,
          settledAt: new Date().toISOString()
        };
      }

      transaction.partialSign(this.keypair);
      const signature = await this.connection.sendRawTransaction(transaction.serialize());
      await this.connection.confirmTransaction(signature, "confirmed");
      return {
        success: true,
        network: this.config.paymentNetwork,
        transaction: signature,
        payer: verification.payer,
        settledAt: new Date().toISOString()
      };
    } catch (error) {
      this.settlementCache.delete(cacheKey);
      return {
        success: false,
        network: this.config.paymentNetwork,
        payer: verification.payer,
        error: error instanceof Error ? error.message : "Failed to settle payment."
      };
    }
  }
}