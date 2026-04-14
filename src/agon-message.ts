import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";

import { encodeCompactU64, encodeU16LE } from "./varint.js";

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }

  return output;
}

export function hexToBytes(hex: `0x${string}` | string): Uint8Array {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (normalized.length === 0 || normalized.length % 2 !== 0) {
    throw new Error("Hex payload must have an even number of characters");
  }

  return Uint8Array.from(Buffer.from(normalized, "hex"));
}

export function hexToFixedBytes(hex: string, size: number): Uint8Array {
  const bytes = hexToBytes(hex);
  if (bytes.length !== size) {
    throw new Error(`Expected ${size} bytes, received ${bytes.length}`);
  }
  return bytes;
}

export function createCommitmentMessageV4(input: {
  messageDomain: Uint8Array;
  payerId: number;
  payeeId: number;
  tokenId: number;
  committedAmount: bigint;
}): Uint8Array {
  if (input.messageDomain.length !== 16) {
    throw new Error(
      `Agon V4 message_domain must be 16 bytes, got ${input.messageDomain.length}`
    );
  }

  return concatBytes([
    Uint8Array.from([0x01, 0x04]),
    input.messageDomain,
    Uint8Array.from([0x00]),
    encodeCompactU64(BigInt(input.payerId)),
    encodeCompactU64(BigInt(input.payeeId)),
    encodeU16LE(input.tokenId),
    encodeCompactU64(input.committedAmount),
  ]);
}

export function verifyCommitmentSignatureV4(input: {
  messageDomain: Uint8Array;
  payerId: number;
  payeeId: number;
  tokenId: number;
  committedAmount: bigint;
  signatureHex: `0x${string}`;
  authorizedSigner: PublicKey;
}): boolean {
  const payload = createCommitmentMessageV4({
    messageDomain: input.messageDomain,
    payerId: input.payerId,
    payeeId: input.payeeId,
    tokenId: input.tokenId,
    committedAmount: input.committedAmount,
  });
  const signature = hexToFixedBytes(input.signatureHex, nacl.sign.signatureLength);
  return nacl.sign.detached.verify(
    payload,
    signature,
    input.authorizedSigner.toBytes()
  );
}
