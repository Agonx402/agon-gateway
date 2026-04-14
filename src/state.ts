import fs from "node:fs";
import path from "node:path";

import type {
  GatewayAcceptedCommitmentRecord,
  GatewaySessionRecord,
  GatewayTopUpQuoteRecord,
  GatewayUsageRecord,
} from "./types.js";

interface PersistedGatewayState {
  sessions: Record<string, SerializedSessionRecord>;
  usage: SerializedUsageRecord[];
  topUpQuotes: Record<string, SerializedTopUpQuoteRecord>;
}

interface SerializedAcceptedCommitmentRecord {
  payerId: number;
  payeeId: number;
  tokenId: number;
  committedAmount: string;
  signatureHex: `0x${string}`;
  authorizedSigner: string;
  acceptedAt: string;
  rpcMethod: string;
}

interface SerializedSessionRecord {
  walletAddress: string;
  payerId: number;
  payeeId: number;
  tokenId: number;
  lockedBalance: string;
  availableBalance: string;
  latestAcceptedCumulative: string;
  authorizedSigner?: string;
  updatedAt: string;
  latestAcceptedCommitment?: SerializedAcceptedCommitmentRecord;
  lastSettlementSignature?: string;
  lastSettledAt?: string;
}

interface SerializedUsageRecord {
  id: string;
  walletAddress: string;
  method: string;
  microAgonPrice: number;
  previousAcceptedCumulative: string;
  newCommittedAmount: string;
  createdAt: string;
}

interface SerializedTopUpQuoteRecord {
  id: string;
  walletAddress: string;
  quotedUnits: string;
  quotedMicroAgon: number;
  fundedSolLamports: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  tokenTransferSignature?: string;
  solTransferSignature?: string;
}

function deserializeAcceptedCommitment(
  commitment: SerializedAcceptedCommitmentRecord
): GatewayAcceptedCommitmentRecord {
  return {
    ...commitment,
    committedAmount: BigInt(commitment.committedAmount),
  };
}

function serializeAcceptedCommitment(
  commitment: GatewayAcceptedCommitmentRecord
): SerializedAcceptedCommitmentRecord {
  return {
    ...commitment,
    committedAmount: commitment.committedAmount.toString(),
  };
}

function deserializeSession(
  session: SerializedSessionRecord
): GatewaySessionRecord {
  return {
    ...session,
    lockedBalance: BigInt(session.lockedBalance),
    availableBalance: BigInt(session.availableBalance),
    latestAcceptedCumulative: BigInt(session.latestAcceptedCumulative),
    latestAcceptedCommitment: session.latestAcceptedCommitment
      ? deserializeAcceptedCommitment(session.latestAcceptedCommitment)
      : undefined,
  };
}

function serializeSession(
  session: GatewaySessionRecord
): SerializedSessionRecord {
  return {
    ...session,
    lockedBalance: session.lockedBalance.toString(),
    availableBalance: session.availableBalance.toString(),
    latestAcceptedCumulative: session.latestAcceptedCumulative.toString(),
    latestAcceptedCommitment: session.latestAcceptedCommitment
      ? serializeAcceptedCommitment(session.latestAcceptedCommitment)
      : undefined,
  };
}

function deserializeUsage(usage: SerializedUsageRecord): GatewayUsageRecord {
  return {
    ...usage,
    previousAcceptedCumulative: BigInt(usage.previousAcceptedCumulative),
    newCommittedAmount: BigInt(usage.newCommittedAmount),
  };
}

function serializeUsage(usage: GatewayUsageRecord): SerializedUsageRecord {
  return {
    ...usage,
    previousAcceptedCumulative: usage.previousAcceptedCumulative.toString(),
    newCommittedAmount: usage.newCommittedAmount.toString(),
  };
}

function deserializeTopUpQuote(
  quote: SerializedTopUpQuoteRecord
): GatewayTopUpQuoteRecord {
  return {
    ...quote,
    quotedUnits: BigInt(quote.quotedUnits),
    fundedSolLamports: BigInt(quote.fundedSolLamports),
  };
}

function serializeTopUpQuote(
  quote: GatewayTopUpQuoteRecord
): SerializedTopUpQuoteRecord {
  return {
    ...quote,
    quotedUnits: quote.quotedUnits.toString(),
    fundedSolLamports: quote.fundedSolLamports.toString(),
  };
}

export class GatewayStateStore {
  private readonly storagePath: string;
  private state: PersistedGatewayState;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    this.state = this.load();
  }

  getSession(walletAddress: string): GatewaySessionRecord | null {
    const session = this.state.sessions[walletAddress];
    return session ? deserializeSession(session) : null;
  }

  upsertSession(session: GatewaySessionRecord): GatewaySessionRecord {
    this.state.sessions[session.walletAddress] = serializeSession(session);
    this.save();
    return session;
  }

  recordUsage(usage: GatewayUsageRecord): GatewayUsageRecord {
    this.state.usage.push(serializeUsage(usage));
    this.save();
    return usage;
  }

  listSessions(): GatewaySessionRecord[] {
    return Object.values(this.state.sessions).map(deserializeSession);
  }

  listUsage(limit = 100): GatewayUsageRecord[] {
    return this.state.usage.slice(-limit).map(deserializeUsage);
  }

  issueTopUpQuote(quote: GatewayTopUpQuoteRecord): GatewayTopUpQuoteRecord {
    this.state.topUpQuotes[quote.id] = serializeTopUpQuote(quote);
    this.save();
    return quote;
  }

  getTopUpQuote(id: string): GatewayTopUpQuoteRecord | null {
    const quote = this.state.topUpQuotes[id];
    return quote ? deserializeTopUpQuote(quote) : null;
  }

  upsertTopUpQuote(quote: GatewayTopUpQuoteRecord): GatewayTopUpQuoteRecord {
    this.state.topUpQuotes[quote.id] = serializeTopUpQuote(quote);
    this.save();
    return quote;
  }

  private load(): PersistedGatewayState {
    if (!fs.existsSync(this.storagePath)) {
      return { sessions: {}, usage: [], topUpQuotes: {} };
    }

    const raw = fs.readFileSync(this.storagePath, "utf8");
    const parsed = JSON.parse(raw) as PersistedGatewayState;
    return {
      sessions: parsed.sessions ?? {},
      usage: parsed.usage ?? [],
      topUpQuotes: parsed.topUpQuotes ?? {},
    };
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
    fs.writeFileSync(this.storagePath, JSON.stringify(this.state, null, 2));
  }
}
