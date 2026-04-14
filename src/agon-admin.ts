import fs from "node:fs";
import { createHash } from "node:crypto";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Ed25519Program,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import { findChannelPda, findParticipantPda } from "./agon-state.js";
import type { GatewayConfig } from "./config.js";
import type { GatewaySettlementCandidate } from "./types.js";

const GLOBAL_CONFIG_SEED = "global-config";
const TOKEN_REGISTRY_SEED = "token-registry";

function encodeCompactU64(value: bigint): number[] {
  if (value < 0n) {
    throw new Error("Compact values must be unsigned");
  }
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining > 0n);
  return bytes;
}

function encodeU16LE(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

function instructionDiscriminator(name: string): Buffer {
  return createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8);
}

function createCommitmentMessageV4(params: {
  messageDomain: Uint8Array;
  payerId: number;
  payeeId: number;
  tokenId: number;
  committedAmount: bigint;
}): Buffer {
  return Buffer.concat([
    Buffer.from([0x01, 0x04]),
    Buffer.from(params.messageDomain),
    Buffer.from([0]),
    Buffer.from(encodeCompactU64(BigInt(params.payerId))),
    Buffer.from(encodeCompactU64(BigInt(params.payeeId))),
    encodeU16LE(params.tokenId),
    Buffer.from(encodeCompactU64(params.committedAmount)),
  ]);
}

function createMultiMessageEd25519Instruction(
  entries: Array<{
    publicKey: PublicKey;
    message: Buffer;
    signatureHex: `0x${string}`;
  }>
): TransactionInstruction {
  const numSigs = entries.length;
  if (numSigs === 0) {
    throw new Error("At least one signed commitment is required");
  }

  const headerSize = 2 + 14 * numSigs;
  let cursor = headerSize;
  const buffers: Buffer[] = [];
  const offsetRows: Array<{
    signatureOffset: number;
    publicKeyOffset: number;
    messageOffset: number;
    messageLength: number;
  }> = [];

  for (const entry of entries) {
    const signature = Buffer.from(entry.signatureHex.slice(2), "hex");
    if (signature.length !== 64) {
      throw new Error("Ed25519 signatures must be 64 bytes");
    }

    const publicKeyOffset = cursor;
    const signatureOffset = publicKeyOffset + 32;
    const messageOffset = signatureOffset + 64;

    buffers.push(entry.publicKey.toBuffer(), signature, entry.message);
    offsetRows.push({
      signatureOffset,
      publicKeyOffset,
      messageOffset,
      messageLength: entry.message.length,
    });
    cursor = messageOffset + entry.message.length;
  }

  const data = Buffer.alloc(cursor);
  data[0] = numSigs;
  data[1] = 0;

  offsetRows.forEach((row, index) => {
    const headerOffset = 2 + index * 14;
    data.writeUInt16LE(row.signatureOffset, headerOffset);
    data.writeUInt16LE(0xffff, headerOffset + 2);
    data.writeUInt16LE(row.publicKeyOffset, headerOffset + 4);
    data.writeUInt16LE(0xffff, headerOffset + 6);
    data.writeUInt16LE(row.messageOffset, headerOffset + 8);
    data.writeUInt16LE(row.messageLength, headerOffset + 10);
    data.writeUInt16LE(0xffff, headerOffset + 12);
  });

  let writeOffset = headerSize;
  for (const buffer of buffers) {
    buffer.copy(data, writeOffset);
    writeOffset += buffer.length;
  }

  return new TransactionInstruction({
    keys: [],
    programId: Ed25519Program.programId,
    data,
  });
}

export class AgonGatewayAdmin {
  readonly connection: Connection;
  readonly programId: PublicKey;
  readonly tokenMint: PublicKey;
  readonly gatewayPayeeWallet: PublicKey;
  readonly operator: Keypair;
  readonly messageDomain: Uint8Array;

  constructor(private readonly config: GatewayConfig) {
    if (!config.operatorWalletPath) {
      throw new Error(
        "AGON_OPERATOR_WALLET_PATH is required for gateway top-ups and settlement"
      );
    }

    const secretKey = Uint8Array.from(
      JSON.parse(fs.readFileSync(config.operatorWalletPath, "utf8"))
    );
    this.operator = Keypair.fromSecretKey(secretKey);
    this.connection = new Connection(config.agonRpcUrl, "confirmed");
    this.programId = new PublicKey(config.agonProgramId);
    if (!config.tokenMint) {
      throw new Error("AGON_GATEWAY_TOKEN_MINT is required for gateway admin actions");
    }
    this.tokenMint = new PublicKey(config.tokenMint);
    this.gatewayPayeeWallet = new PublicKey(config.gatewayPayeeWallet);
    this.messageDomain = Uint8Array.from(
      Buffer.from(config.agonMessageDomainHex, "hex")
    );
  }

  private get globalConfigPda(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(GLOBAL_CONFIG_SEED)],
      this.programId
    )[0];
  }

  private get tokenRegistryPda(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(TOKEN_REGISTRY_SEED)],
      this.programId
    )[0];
  }

  private get gatewayPayeeParticipantPda(): PublicKey {
    return findParticipantPda(this.programId, this.gatewayPayeeWallet);
  }

  private async sendTransaction(
    instructions: TransactionInstruction[]
  ): Promise<string> {
    const latestBlockhash = await this.connection.getLatestBlockhash("confirmed");
    const transaction = new Transaction({
      feePayer: this.operator.publicKey,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });
    transaction.add(...instructions);
    transaction.sign(this.operator);

    const signature = await this.connection.sendRawTransaction(
      transaction.serialize(),
      { preflightCommitment: "confirmed" }
    );
    await this.connection.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      "confirmed"
    );
    return signature;
  }

  async topUpWallet(params: {
    walletAddress: string;
    tokenUnits: bigint;
    solLamports: bigint;
  }): Promise<{
    tokenTransferSignature: string;
    solTransferSignature?: string;
  }> {
    const recipient = new PublicKey(params.walletAddress);
    const sourceAta = getAssociatedTokenAddressSync(
      this.tokenMint,
      this.operator.publicKey
    );
    const destinationAta = getAssociatedTokenAddressSync(this.tokenMint, recipient);
    const instructions: TransactionInstruction[] = [];

    const destinationInfo = await this.connection.getAccountInfo(
      destinationAta,
      "confirmed"
    );
    if (!destinationInfo) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          this.operator.publicKey,
          destinationAta,
          recipient,
          this.tokenMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }

    instructions.push(
      createTransferCheckedInstruction(
        sourceAta,
        this.tokenMint,
        destinationAta,
        this.operator.publicKey,
        params.tokenUnits,
        6
      )
    );

    const tokenTransferSignature = await this.sendTransaction(instructions);

    let solTransferSignature: string | undefined;
    if (params.solLamports > 0n) {
      solTransferSignature = await this.sendTransaction([
        SystemProgram.transfer({
          fromPubkey: this.operator.publicKey,
          toPubkey: recipient,
          lamports: Number(params.solLamports),
        }),
      ]);
    }

    return {
      tokenTransferSignature,
      solTransferSignature,
    };
  }

  async settleCommitmentBundle(
    commitments: GatewaySettlementCandidate[]
  ): Promise<string> {
    if (commitments.length === 0) {
      throw new Error("No pending commitments to settle");
    }
    if (commitments.length > 255) {
      throw new Error("Bundle settlement supports at most 255 commitments");
    }

    const sorted = [...commitments].sort((left, right) =>
      left.payerId - right.payerId
    );

    const ed25519Instruction = createMultiMessageEd25519Instruction(
      sorted.map((commitment) => ({
        publicKey: new PublicKey(commitment.authorizedSigner),
        message: createCommitmentMessageV4({
          messageDomain: this.messageDomain,
          payerId: commitment.payerId,
          payeeId: commitment.payeeId,
          tokenId: commitment.tokenId,
          committedAmount: commitment.committedAmount,
        }),
        signatureHex: commitment.signatureHex,
      }))
    );

    const instruction = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: this.tokenRegistryPda, isSigner: false, isWritable: false },
        { pubkey: this.globalConfigPda, isSigner: false, isWritable: false },
        {
          pubkey: this.gatewayPayeeParticipantPda,
          isSigner: false,
          isWritable: true,
        },
        { pubkey: this.operator.publicKey, isSigner: true, isWritable: true },
        {
          pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
          isSigner: false,
          isWritable: false,
        },
        ...sorted.flatMap((commitment) => [
          {
            pubkey: findParticipantPda(
              this.programId,
              new PublicKey(commitment.walletAddress)
            ),
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: findChannelPda(
              this.programId,
              commitment.payerId,
              commitment.payeeId,
              commitment.tokenId
            ),
            isSigner: false,
            isWritable: true,
          },
        ]),
      ],
      data: Buffer.concat([
        instructionDiscriminator("settle_commitment_bundle"),
        Buffer.from([sorted.length]),
      ]),
    });

    return this.sendTransaction([ed25519Instruction, instruction]);
  }
}
