# Agon Gateway

Agon Gateway is a Vercel-ready x402 seller for paid Solana RPC and DAS routes.

This version is intentionally narrow and safe:

- standard x402 `exact` flow only
- Solana mainnet USDC settlement
- Alchemy + Helius upstreams
- replay protection and rate limiting backed by Upstash Redis
- internal self-hosted facilitator endpoints protected by a shared secret
- no Agon-native payment flow yet

## Public routes

- `GET /healthz`
- `GET /v1/catalog`
- `POST /v1/x402/solana/{cluster}/{provider}/{surface}/{method}`

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

## Internal facilitator routes

These are server-to-server only and must not be exposed in product docs or discovery metadata:

- `GET /api/internal/facilitator/supported`
- `POST /api/internal/facilitator/verify`
- `POST /api/internal/facilitator/settle`

They require:

- `x-agon-internal-secret: <AGON_INTERNAL_SETTLEMENT_SECRET>`

## Payment flow

Every paid route uses standard x402 exact payment:

1. request the paid route
2. receive `402 Payment Required`
3. retry with `PAYMENT-SIGNATURE`
4. verify the payment and call the upstream provider
5. settle through the internal facilitator only after a successful upstream response
6. serve the response

Current payment rail:

- network: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`
- asset: mainnet USDC
- price: `$0.01` per call

## Hosted safety model

For Vercel, the gateway avoids local disk and in-memory-only safety assumptions:

- replay protection is stored in Upstash Redis
- rate limiting is stored in Upstash Redis
- usage counters are stored in Upstash Redis
- structured event logs go to stdout for Vercel logs

Rate limits:

- unpaid challenges: `120/min` per IP
- RPC routes: `50 rps`
- DAS routes: `10 rps`

Request guardrails:

- `getProgramAccounts` requires at least one filter and a `dataSlice.length <= 256`
- paginated list methods cap `limit` at `100`
- malformed or overly broad request payloads are rejected before settlement

## Environment

Copy `.env.example` and set:

- `AGON_GATEWAY_BASE_URL`
- `AGON_INTERNAL_SETTLEMENT_SECRET`
- `AGON_FACILITATOR_WALLET_B64` for hosted deploys
- `AGON_FACILITATOR_WALLET_PATH` only for local fallback
- `AGON_X402_PAY_TO_WALLET`
- `AGON_X402_USDC_MINT`
- `AGON_X402_PRICE_USD`
- `AGON_X402_PRICE_ATOMIC`
- `SOLANA_MAINNET_RPC_URL`
- `ALCHEMY_MAINNET_RPC_URL`
- `ALCHEMY_DEVNET_RPC_URL`
- `HELIUS_MAINNET_RPC_URL`
- `HELIUS_DEVNET_RPC_URL`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

## Local build

```bash
npm install
npm run check
npm run build
```

## Local dev

```bash
npm run dev
```

## Vercel deploy

The repo now builds as a Next.js app-router backend on Vercel.

Recommended rollout:

1. deploy to the default `*.vercel.app` domain
2. verify `/healthz`
3. verify `/v1/catalog` with real env values
4. test one unpaid `402`
5. test one successful paid request
6. point `gateway.agonx402.com` at the Vercel project

## Phantom key conversion

If Phantom gives you a base58 private key instead of a Solana wallet JSON file:

```bash
npm run convert:phantom -- "<PHANTOM_BASE58_PRIVATE_KEY>" ../facilitator-wallet.json
```

Or from a text file:

```bash
npm run convert:phantom -- ./phantom-private-key.txt ../facilitator-wallet.json
```

The converter writes a standard 64-byte Solana keypair JSON array and prints the derived public key so you can confirm it before base64-encoding it for `AGON_FACILITATOR_WALLET_B64`.
