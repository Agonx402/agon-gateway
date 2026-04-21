# Agon Gateway

Agon Gateway is a Vercel-ready x402 gateway for paid Solana RPC/DAS routes and wallet-authenticated Tokens API routes.

This version is intentionally narrow and safe:

- standard x402 `exact` flow for paid infrastructure routes
- SIWX auth-only x402 flow for Tokens API routes
- self-hosted facilitator for standard x402 verification + settlement
- Solana mainnet USDC settlement
- Alchemy + Helius upstreams
- Tokens API v1 proxying with server-side `x-api-key` auth and wallet signatures instead of end-user API keys
- replay protection and rate limiting backed by Upstash Redis
- internal self-hosted facilitator endpoints protected by a shared secret
- no Agon-native payment flow yet

## Public routes

- `GET /healthz`
- `GET /v1/catalog`
- `POST /v1/x402/solana/{cluster}/{provider}/{surface}/{method}`
- `GET /v1/x402/helius/wallet/...`
- `POST /v1/x402/helius/wallet/batch-identity`
- `GET /v1/x402/tokens/...`
- `POST /v1/x402/tokens/assets/market-snapshots`

Catalog helpers:

- `GET /v1/catalog` returns the full flat route list plus provider categories
- `GET /v1/catalog?provider=alchemy`
- `GET /v1/catalog?provider=helius`
- `GET /v1/catalog?provider=tokens` (also accepts `tokensapi`)

Supported clusters:

- `mainnet`
- `devnet`

Supported providers:

- `alchemy`
- `helius`
- `tokens` (`TokensAPI` in catalog labels)

Supported RPC methods:

- `getBalance`
- `getAccountInfo`
- `getTransaction`
- `getSignaturesForAddress`
- `getTokenAccountsByOwner`
- `getProgramAccounts`
- `getTransactionsForAddress` (Helius only — enhanced transaction history with filtering, sorting, and keyset pagination)

Supported DAS methods:

- `getAsset`
- `getAssetsByOwner`
- `searchAssets`

Supported Helius Wallet API routes (100 credits per call = `$0.0005`):

- `GET /v1/x402/helius/wallet/identity/:wallet`
- `POST /v1/x402/helius/wallet/batch-identity`
- `GET /v1/x402/helius/wallet/balances/:wallet`
- `GET /v1/x402/helius/wallet/history/:wallet`
- `GET /v1/x402/helius/wallet/transfers/:wallet`
- `GET /v1/x402/helius/wallet/funded-by/:wallet`

Devnet route family (same methods, explicit cluster in path):

- `GET /v1/x402/helius/devnet/wallet/identity/:wallet`
- `POST /v1/x402/helius/devnet/wallet/batch-identity`
- `GET /v1/x402/helius/devnet/wallet/balances/:wallet`
- `GET /v1/x402/helius/devnet/wallet/history/:wallet`
- `GET /v1/x402/helius/devnet/wallet/transfers/:wallet`
- `GET /v1/x402/helius/devnet/wallet/funded-by/:wallet`

The `:wallet` path param accepts a base58 Solana address, an SNS `.sol` domain, or an ANS custom TLD (e.g. `miester.bonk`). Domain resolution is mainnet-only.

Supported Tokens API routes:

- `GET /v1/x402/tokens/health`
- `GET /v1/x402/tokens/assets/search`
- `GET /v1/x402/tokens/assets/resolve`
- `GET /v1/x402/tokens/assets/curated`
- `POST /v1/x402/tokens/assets/market-snapshots`
- `GET /v1/x402/tokens/assets/variant-markets`
- `GET /v1/x402/tokens/assets/risk-summary`
- `GET /v1/x402/tokens/assets/:assetId`
- `GET /v1/x402/tokens/assets/:assetId/variants`
- `GET /v1/x402/tokens/assets/:assetId/variant-top-markets`
- `GET /v1/x402/tokens/assets/:assetId/variant-market`
- `GET /v1/x402/tokens/assets/:assetId/markets`
- `GET /v1/x402/tokens/assets/:assetId/ohlcv`
- `GET /v1/x402/tokens/assets/:assetId/price-chart`
- `GET /v1/x402/tokens/assets/:assetId/profile`
- `GET /v1/x402/tokens/assets/:assetId/tickers`
- `GET /v1/x402/tokens/assets/:assetId/risk-summary`
- `GET /v1/x402/tokens/assets/:assetId/risk-details`
- `GET /v1/x402/tokens/assets/:assetId/description`

Not proxied:

- `GET /v1/whoami`

The Tokens docs mark `whoami` as a first-party Clerk-session endpoint rather than an API-key endpoint, so it is intentionally excluded from the gateway surface.

## Internal facilitator routes

These are server-to-server only and must not be exposed in product docs or discovery metadata:

- `GET /api/internal/facilitator/supported`
- `POST /api/internal/facilitator/verify`
- `POST /api/internal/facilitator/settle`

They require:

- `x-agon-internal-secret: <AGON_INTERNAL_SETTLEMENT_SECRET>`

## Access flow

Paid Solana RPC / DAS routes use standard x402 exact payment:

1. request the paid route
2. receive `402 Payment Required`
3. retry with `PAYMENT-SIGNATURE`
4. verify the payment and call the upstream provider
5. settle through the internal facilitator only after a successful upstream response
6. serve the response

Tokens API routes use SIWX auth-only x402:

1. request a Tokens route
2. receive `402 Payment Required` with `sign-in-with-x`
3. retry with `SIGN-IN-WITH-X`
4. verify the wallet signature
5. call the upstream Tokens API and serve the response

Current payment rail:

- network: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`
- asset: mainnet USDC
- Solana RPC / DAS routes are priced per endpoint from the upstream provider's published PAYG schedule
- Alchemy routes use current Compute Unit pricing, rounded up to the nearest USDC micro when needed
- Helius routes use current per-credit pricing
- Tokens API routes: no payment, wallet-authenticated via SIWX

Bazaar discovery note:

- exact-payment POST routes must be challenged with the final JSON body you intend to buy
- the paid retry must reuse the exact same method, URL, and JSON body
- empty-body probes are only valid for free/auth-only routes

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
- Tokens API routes: wallet-authenticated via SIWX and still capped at `30 rpm` across the shared upstream API key by default

Request guardrails:

- `getProgramAccounts` requires at least one filter and a `dataSlice.length <= 256`
- paginated list methods cap `limit` at `100`
- Tokens API batch routes cap `market-snapshots` at `250` ids and `variant-markets` at `50`
- Tokens API asset/query routes validate documented enums and pagination bounds before payment settlement
- malformed or overly broad request payloads are rejected before settlement

## Environment

Copy `.env.example` and set:

- `AGON_GATEWAY_BASE_URL`
- `AGON_FACILITATOR_WALLET_BASE58`
- `AGON_INTERNAL_SETTLEMENT_SECRET`
- `AGON_X402_PAY_TO_WALLET`
- `AGON_X402_USDC_MINT`
- `SOLANA_MAINNET_RPC_URL`
- `ALCHEMY_MAINNET_RPC_URL`
- `ALCHEMY_DEVNET_RPC_URL`
- `HELIUS_MAINNET_RPC_URL`
- `HELIUS_DEVNET_RPC_URL`
- `HELIUS_API_KEY` (bare Helius API key, used as `X-Api-Key` for the Helius Wallet API)
- `HELIUS_WALLET_API_BASE_URL` (defaults to `https://api.helius.xyz`)
- `TOKENS_API_BASE_URL`
- `TOKENS_API_KEY`
- `AGON_RATE_LIMIT_TOKENS_PER_MINUTE`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Optional legacy config if you still want to keep CDP auth material around for other tooling:

- `CDP_API_KEY_ID`
- `CDP_API_KEY_SECRET`

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

## Catalog shape

`/v1/catalog` remains backward-compatible for clients that only read `routes`, but it now also returns:

- `catalog.totalRoutes`
- `catalog.returnedRoutes`
- `catalog.filters.provider`
- `categories.providers[]` with labels, counts, and provider-specific `href`s
- per-route `accessMode` values (`exact` for paid Solana routes, `siwx` for Tokens routes)

That lets clients either:

- fetch the full catalog once and render provider sections from `categories.providers`, or
- fetch a provider-scoped catalog directly with `?provider=alchemy|helius|tokens`

## Facilitator wallet format

Set `AGON_FACILITATOR_WALLET_BASE58` to the raw base58-encoded 64-byte Solana secret key for the facilitator wallet.

Do not paste a JSON array like `[12,34,...]` here. This value must be the base58 string itself.
