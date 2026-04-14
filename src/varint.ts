export function encodeCompactU64(value: bigint): Uint8Array {
  if (value < 0n) {
    throw new Error("Compact varints only support unsigned values");
  }

  const bytes: number[] = [];
  let remaining = value;

  do {
    let current = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) {
      current |= 0x80;
    }
    bytes.push(current);
  } while (remaining > 0n);

  return Uint8Array.from(bytes);
}

export function encodeU16LE(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`Expected u16, received ${value}`);
  }

  return Uint8Array.from([value & 0xff, (value >> 8) & 0xff]);
}
