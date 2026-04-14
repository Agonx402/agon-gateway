import { Connection, PublicKey } from "@solana/web3.js";

import type { GatewayConfig } from "./config.js";

const PARTICIPANT_SEED = "participant";
const CHANNEL_SEED = "channel-v2";

const PARTICIPANT_OWNER_OFFSET = 8;
const PARTICIPANT_ID_OFFSET = 40;
const PARTICIPANT_TOKEN_BALANCES_LEN_OFFSET = 44;
const PARTICIPANT_TOKEN_BALANCES_DATA_OFFSET = 48;
const PARTICIPANT_TOKEN_BALANCE_SPACE = 58;
const PARTICIPANT_TOKEN_ID_OFFSET = 0;
const PARTICIPANT_AVAILABLE_BALANCE_OFFSET = 2;
const PARTICIPANT_WITHDRAWING_BALANCE_OFFSET = 10;
const PARTICIPANT_BUMP_BASE_OFFSET = PARTICIPANT_TOKEN_BALANCES_DATA_OFFSET;

const CHANNEL_TOKEN_ID_OFFSET = 8;
const CHANNEL_PAYER_ID_OFFSET = 10;
const CHANNEL_PAYEE_ID_OFFSET = 14;
const CHANNEL_SETTLED_CUMULATIVE_OFFSET = 18;
const CHANNEL_LOCKED_BALANCE_OFFSET = 26;
const CHANNEL_AUTHORIZED_SIGNER_OFFSET = 34;
const CHANNEL_PENDING_UNLOCK_AMOUNT_OFFSET = 66;
const CHANNEL_UNLOCK_REQUESTED_AT_OFFSET = 74;
const CHANNEL_PENDING_AUTHORIZED_SIGNER_OFFSET = 82;
const CHANNEL_AUTHORIZED_SIGNER_UPDATE_REQUESTED_AT_OFFSET = 114;
const CHANNEL_BUMP_OFFSET = 122;

function readU16LE(buffer: Buffer, offset: number): number {
  return buffer.readUInt16LE(offset);
}

function readU32LE(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset);
}

function readU64LE(buffer: Buffer, offset: number): bigint {
  return buffer.readBigUInt64LE(offset);
}

function readI64LE(buffer: Buffer, offset: number): bigint {
  return buffer.readBigInt64LE(offset);
}

export function findParticipantPda(
  programId: PublicKey,
  owner: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PARTICIPANT_SEED), owner.toBytes()],
    programId
  )[0];
}

export function findChannelPda(
  programId: PublicKey,
  payerId: number,
  payeeId: number,
  tokenId: number
): PublicKey {
  const payerBytes = Buffer.alloc(4);
  payerBytes.writeUInt32LE(payerId, 0);
  const payeeBytes = Buffer.alloc(4);
  payeeBytes.writeUInt32LE(payeeId, 0);
  const tokenBytes = Buffer.alloc(2);
  tokenBytes.writeUInt16LE(tokenId, 0);

  return PublicKey.findProgramAddressSync(
    [Buffer.from(CHANNEL_SEED), payerBytes, payeeBytes, tokenBytes],
    programId
  )[0];
}

function parseParticipantAccount(
  owner: PublicKey,
  participantPda: PublicKey,
  accountData: Buffer,
  tokenId: number
) {
  const participantId = readU32LE(accountData, PARTICIPANT_ID_OFFSET);
  const tokenBalanceCount = readU32LE(
    accountData,
    PARTICIPANT_TOKEN_BALANCES_LEN_OFFSET
  );

  let offset = PARTICIPANT_TOKEN_BALANCES_DATA_OFFSET;
  let availableBalance = 0n;
  let withdrawingBalance = 0n;

  for (let index = 0; index < tokenBalanceCount; index += 1) {
    const entryTokenId = readU16LE(
      accountData,
      offset + PARTICIPANT_TOKEN_ID_OFFSET
    );
    if (entryTokenId === tokenId) {
      availableBalance = readU64LE(
        accountData,
        offset + PARTICIPANT_AVAILABLE_BALANCE_OFFSET
      );
      withdrawingBalance = readU64LE(
        accountData,
        offset + PARTICIPANT_WITHDRAWING_BALANCE_OFFSET
      );
      break;
    }
    offset += PARTICIPANT_TOKEN_BALANCE_SPACE;
  }

  const bumpOffset =
    PARTICIPANT_BUMP_BASE_OFFSET +
    tokenBalanceCount * PARTICIPANT_TOKEN_BALANCE_SPACE;
  const bump = accountData.readUInt8(bumpOffset);
  const inboundChannelPolicy = accountData.readUInt8(bumpOffset + 1);

  return {
    owner: owner.toString(),
    participantPda: participantPda.toString(),
    participantId,
    availableBalance,
    withdrawingBalance,
    totalBalance: availableBalance + withdrawingBalance,
    bump,
    inboundChannelPolicy,
  };
}

function parseChannelAccount(channelPda: PublicKey, accountData: Buffer) {
  const tokenId = readU16LE(accountData, CHANNEL_TOKEN_ID_OFFSET);
  const payerId = readU32LE(accountData, CHANNEL_PAYER_ID_OFFSET);
  const payeeId = readU32LE(accountData, CHANNEL_PAYEE_ID_OFFSET);
  const settledCumulative = readU64LE(accountData, CHANNEL_SETTLED_CUMULATIVE_OFFSET);
  const lockedBalance = readU64LE(accountData, CHANNEL_LOCKED_BALANCE_OFFSET);
  const authorizedSigner = new PublicKey(
    accountData.subarray(
      CHANNEL_AUTHORIZED_SIGNER_OFFSET,
      CHANNEL_AUTHORIZED_SIGNER_OFFSET + 32
    )
  );
  const pendingAuthorizedSigner = new PublicKey(
    accountData.subarray(
      CHANNEL_PENDING_AUTHORIZED_SIGNER_OFFSET,
      CHANNEL_PENDING_AUTHORIZED_SIGNER_OFFSET + 32
    )
  );

  return {
    channelPda: channelPda.toString(),
    tokenId,
    payerId,
    payeeId,
    settledCumulative,
    lockedBalance,
    authorizedSigner: authorizedSigner.toString(),
    authorizedSignerPubkey: authorizedSigner,
    pendingUnlockAmount: readU64LE(accountData, CHANNEL_PENDING_UNLOCK_AMOUNT_OFFSET),
    unlockRequestedAt: readI64LE(accountData, CHANNEL_UNLOCK_REQUESTED_AT_OFFSET),
    pendingAuthorizedSigner: pendingAuthorizedSigner.toString(),
    authorizedSignerUpdateRequestedAt: readI64LE(
      accountData,
      CHANNEL_AUTHORIZED_SIGNER_UPDATE_REQUESTED_AT_OFFSET
    ),
    bump: accountData.readUInt8(CHANNEL_BUMP_OFFSET),
  };
}

export interface LiveParticipantState {
  owner: string;
  participantPda: string;
  participantId: number;
  availableBalance: bigint;
  withdrawingBalance: bigint;
  totalBalance: bigint;
  bump: number;
  inboundChannelPolicy: number;
}

export interface LiveChannelState {
  channelPda: string;
  tokenId: number;
  payerId: number;
  payeeId: number;
  settledCumulative: bigint;
  lockedBalance: bigint;
  authorizedSigner: string;
  authorizedSignerPubkey: PublicKey;
  pendingUnlockAmount: bigint;
  unlockRequestedAt: bigint;
  pendingAuthorizedSigner: string;
  authorizedSignerUpdateRequestedAt: bigint;
  bump: number;
}

export interface LiveGatewayState {
  walletAddress: string;
  participant: LiveParticipantState | null;
  channel: LiveChannelState | null;
}

export class AgonStateReader {
  private readonly connection: Connection;
  private readonly programId: PublicKey;

  constructor(private readonly config: GatewayConfig) {
    this.connection = new Connection(config.agonRpcUrl, "confirmed");
    this.programId = new PublicKey(config.agonProgramId);
  }

  get messageDomain(): Uint8Array {
    return Uint8Array.from(Buffer.from(this.config.agonMessageDomainHex, "hex"));
  }

  async loadGatewayState(walletAddress: string): Promise<LiveGatewayState> {
    const owner = new PublicKey(walletAddress);
    const participantPda = findParticipantPda(this.programId, owner);
    const participantInfo = await this.connection.getAccountInfo(participantPda, "confirmed");

    if (!participantInfo?.data) {
      return {
        walletAddress,
        participant: null,
        channel: null,
      };
    }
    if (!participantInfo.owner.equals(this.programId)) {
      throw new Error(
        `Participant PDA ${participantPda.toString()} is not owned by the Agon program`
      );
    }

    const participant = parseParticipantAccount(
      owner,
      participantPda,
      Buffer.from(participantInfo.data),
      this.config.tokenId
    );

    const channelPda = findChannelPda(
      this.programId,
      participant.participantId,
      this.config.gatewayPayeeId,
      this.config.tokenId
    );
    const channelInfo = await this.connection.getAccountInfo(channelPda, "confirmed");
    if (channelInfo && !channelInfo.owner.equals(this.programId)) {
      throw new Error(
        `Channel PDA ${channelPda.toString()} is not owned by the Agon program`
      );
    }

    const channel = channelInfo?.data
      ? parseChannelAccount(channelPda, Buffer.from(channelInfo.data))
      : null;

    return {
      walletAddress,
      participant,
      channel,
    };
  }
}
