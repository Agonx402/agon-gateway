import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

function printUsageAndExit() {
  console.error(
    [
      "Usage:",
      "  npm run convert:phantom -- <base58-or-file> [output-path]",
      "",
      "Examples:",
      "  npm run convert:phantom -- \"<PHANTOM_BASE58_PRIVATE_KEY>\" ../facilitator-wallet.json",
      "  npm run convert:phantom -- .\\\\phantom-private-key.txt ..\\\\facilitator-wallet.json"
    ].join("\n")
  );
  process.exit(1);
}

function readInput(input) {
  const candidatePath = path.resolve(process.cwd(), input);
  if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
    return fs.readFileSync(candidatePath, "utf8").trim();
  }
  return input.trim();
}

function parseSecretKey(raw) {
  if (!raw) {
    throw new Error("Input is empty.");
  }

  if (raw.startsWith("[")) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("JSON input must be an array of byte values.");
    }
    return Uint8Array.from(parsed);
  }

  return Uint8Array.from(bs58.decode(raw));
}

function toKeypair(secretBytes) {
  if (secretBytes.length === 64) {
    return Keypair.fromSecretKey(secretBytes);
  }

  if (secretBytes.length === 32) {
    return Keypair.fromSeed(secretBytes);
  }

  throw new Error(
    `Unsupported private key length ${secretBytes.length}. Expected 32-byte seed or 64-byte secret key.`
  );
}

function writeWalletFile(outputPath, keypair) {
  const secretArray = Array.from(keypair.secretKey);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(secretArray, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w"
  });
}

const [, , inputArg, outputArg] = process.argv;
if (!inputArg) {
  printUsageAndExit();
}

const rawInput = readInput(inputArg);
const secretBytes = parseSecretKey(rawInput);
const keypair = toKeypair(secretBytes);
const outputPath = path.resolve(
  process.cwd(),
  outputArg ?? path.join("..", "facilitator-wallet.json")
);

writeWalletFile(outputPath, keypair);

console.log(`Wrote wallet file: ${outputPath}`);
console.log(`Derived public key: ${keypair.publicKey.toBase58()}`);
