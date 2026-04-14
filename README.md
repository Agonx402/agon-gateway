# Agon Gateway

Agon Gateway is the public x402-facing seller for Agon's paid Solana data products.

Phase 2 focuses on one thing: expose route-based, Bazaar-friendly paid endpoints that use the standard x402 exact-payment flow first. Agon-native repeated-use payments come next, after the discovery, docs, MCP, and skill surfaces are ready.

## What this gateway does

- Publishes concrete paid endpoints for Solana RPC and DAS
- Supports both Alchemy and Helius upstreams
- Supports both Solana `mainnet` and `devnet` reads
- Charges a flat `$0.01` per request using Solana mainnet USDC
- Runs its own facilitator flow inside the same service
- Keeps structured logs for unpaid `402` traffic, paid requests, settlement attempts, and general usage

## Current scope

This build is intentionally narrow:

- standard x402 exact flow only
- read-only endpoints only
- no WebSockets
- no write methods such as `sendTransaction`
- no Agon-native flow yet

## Paid route pattern

Routes are explicit and Bazaar-friendly:

```text
/v1/x402/solana/{cluster}/{provider}/rpc/{method}
/v1/x402/solana/{cluster}/{provider}/das/{method}
```

Supported clusters:

- `mainnet`
- `devnet`

Supported providers:

- `alchemy`
- `helius`

Supported RPC methods:

- `getBalance`
- `getAccountInfo`
- `getTransaction`
- `getSignaturesForAddress`
- `getTokenAccountsByOwner`
- `getProgramAccounts`

Supported DAS methods:

- `getAsset`
- `getAssetsByOwner`
- `searchAssets`

## Public routes

- `GET /healthz`
- `GET /v1/catalog`
- `GET /facilitator/supported`
- `POST /facilitator/verify`
- `POST /facilitator/settle`
- `POST /v1/x402/...`

## Payment model

Every paid route returns `402 Payment Required` until the caller retries with a valid `PAYMENT-SIGNATURE` header.

Current payment rail:

- scheme: `exact`
- network: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`
- asset: Solana mainnet USDC
- price: `$0.01` per call

The gateway expects the facilitator wallet to act as the fee payer during settlement.

## Logging

The gateway writes:

- structured JSON logs to stdout
- an append-only NDJSON event ledger to `AGON_GATEWAY_EVENT_LOG_PATH`

Important event types:

- `challenge_issued`
- `payment_received`
- `payment_verified`
- `payment_settle_started`
- `payment_settle_succeeded`
- `payment_settle_failed`
- `upstream_request_started`
- `upstream_request_succeeded`
- `upstream_request_failed`
- `usage_recorded`

## Environment

Copy `.env.example` and set:

- facilitator wallet path
- recipient wallet for USDC payments
- Solana mainnet RPC URL for settlement
- Alchemy mainnet/devnet RPC URLs
- Helius mainnet/devnet RPC URLs

## Build

```bash
npm install
npm run build
npm start
```

## Notes

- This package now compiles from `src-v2/`
- The older Agon-specific gateway implementation is intentionally left out of the active build
- Agon-native payment flow is planned for the next phase once discovery and onboarding surfaces are ready