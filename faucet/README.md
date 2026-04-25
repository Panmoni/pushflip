# @pushflip/faucet

Self-service test-`$FLIP` faucet for the pushflip devnet (Pre-Mainnet 5.0.7).

A small Hono HTTP service that mints test tokens to a recipient wallet on request, rate-limited per-wallet. **The service pays all fees and signs as the mint authority** — this is the critical UX property: a brand-new wallet with 0 SOL can still receive tokens.

## Why this exists

Before this service, the only way to get test-`$FLIP` into a wallet was to message the maintainer and have them run `pnpm --filter @pushflip/scripts mint-test-flip --to <addr>` manually. That works for one tester, not for onboarding.

See [docs/EXECUTION_PLAN.md Pre-Mainnet 5.0.7](../docs/EXECUTION_PLAN.md) for the full decision log (Option 1 — backend service — was chosen over Option 2 — on-chain permissionless mint program — specifically to preserve the "0 SOL → connect wallet → one click → get tokens" flow).

## Endpoints

### `GET /health`

Liveness + balance check. Never returns non-200 so external monitoring can distinguish "service down" from "RPC briefly unhappy."

```json
{
  "status": "ok",
  "authority": "5vzyxxJ1NwoN5PgX1p2zCavbxc7mugLMdF7At5syGfA6",
  "mint": "2KqqB7SRVaD98ZbVaiRWirxbaJv5ryNzkDRGweBZVryF",
  "balance_lamports": "28908072844",
  "faucet_amount_whole_flip": "1000",
  "cooldown_minutes": 1440
}
```

### `POST /faucet`

Mint `FAUCET_AMOUNT_WHOLE_FLIP` to the recipient. Creates the recipient's ATA if missing (idempotent). Rate-limited per-recipient (one request per `COOLDOWN_MINUTES`, default 24h).

Request:

```json
{ "recipient": "Crn4eqJK9zAvFMJw71a3ZSjqVRyHvzWBrP9j4xjXJm7r" }
```

Response shapes:

- **200 OK** — minted:
  ```json
  {
    "status": "ok",
    "signature": "5Tbk3aygjT76kZ...",
    "recipient_ata": "FbyfDoPmk2sY6TukvrSYYyNXNjycTJyv5cMezDeiihnW",
    "amount_base_units": "1000000000000",
    "amount_whole_flip": "1000",
    "explorer_url": "https://explorer.solana.com/tx/...?cluster=devnet"
  }
  ```
- **400 Bad Request** — invalid recipient address:
  ```json
  { "error": "invalid recipient address: ..." }
  ```
- **429 Too Many Requests** — per-wallet cooldown:
  ```json
  {
    "error": "rate_limited",
    "message": "...",
    "retry_after_seconds": 86400,
    "next_available_at_ms": 1776367528184
  }
  ```
- **500 Internal Server Error** — mint failed (RPC drop, faucet out of SOL, etc.):
  ```json
  { "error": "mint_failed", "message": "..." }
  ```

Note: a **failed mint does NOT consume the rate-limit window**. The wallet can retry immediately. The `recordClaim()` call happens only after `sendAndConfirm` returns successfully.

## Configuration

All via env vars (loaded from `.env` in the workspace root by default):

| Var | Required | Default | Description |
|---|---|---|---|
| `PORT` | no | `3001` | HTTP port. Vite dev server runs on 5173, so 3001 stays out of the way. |
| `ALLOWED_ORIGINS` | no | `http://localhost:5173` | Comma-separated CORS allow-list. Replace with production frontend URL(s) for deploy. |
| `FAUCET_KEYPAIR_PATH` | **yes** | — | Path to the dedicated faucet keypair (mint authority on `TEST_FLIP_MINT` — pubkey `5vzyxxJ1NwoN5PgX1p2zCavbxc7mugLMdF7At5syGfA6`). The local CLI wallet `~/.config/solana/id.json` is NO LONGER the mint authority (transferred 2026-04-15 via tx `5GR6KHASrRtRPqbqCwgXbk3nH3vBKZaLRXpMRTegXKuF9guHmv6My5bKifqCGNvnzP7z56TcNBPRfTfkT8pHN1f1`). For local dev, point this at `~/.config/solana/pushflip-faucet.json` (the new keypair, mode 0600); for production, the same file ships to tucker via `scp`. |
| `RPC_ENDPOINT` | **yes** | — | Solana RPC HTTP endpoint (e.g. `https://api.devnet.solana.com`). |
| `WS_ENDPOINT` | **yes** | — | Solana RPC WS endpoint for confirmation tracking (e.g. `wss://api.devnet.solana.com`). |
| `FAUCET_AMOUNT_WHOLE_FLIP` | no | `1000` | How many whole `$FLIP` to mint per request. Scaled by `10^9` internally. |
| `COOLDOWN_MINUTES` | no | `1440` (24h) | Per-wallet rate-limit window. |
| `LOG_LEVEL` | no | `info` | Reserved for future use. |

Missing-or-malformed required vars fail-fast at boot with a descriptive error. Same friendly-error pattern as [`scripts/lib/script-helpers.ts::loadCliKeypair`](../scripts/lib/script-helpers.ts).

## Running locally

```bash
# One-shot
RPC_ENDPOINT=https://api.devnet.solana.com \
WS_ENDPOINT=wss://api.devnet.solana.com \
FAUCET_KEYPAIR_PATH=~/.config/solana/id.json \
pnpm --filter @pushflip/faucet start

# Or with .env in faucet/
pnpm --filter @pushflip/faucet start

# Dev mode (auto-restart on file change)
pnpm --filter @pushflip/faucet dev
```

Expected startup banner:

```
[faucet] listening on http://localhost:3001  authority=3XXMLDEf...  mint=2KqqB7SR...  balance=28908072844 lamports  cooldown=1440m  amount=1000 $FLIP
[faucet] allowed origins: http://localhost:5173
```

## Frontend integration

The app's `<JoinGameDialog>` `<NoAtaFaucetPanel>` calls the faucet via [`app/src/hooks/use-faucet.ts`](../app/src/hooks/use-faucet.ts). It defaults the URL to `http://localhost:3001/faucet` and can be overridden at build time via `VITE_FAUCET_URL`. On success it invalidates the `@tanstack/react-query` token-balance query so the dialog advances without a manual refresh.

## Rate-limit semantics

- **Keyed by recipient wallet**, not requester IP. An attacker rotating IPs can't bypass it; an attacker rotating wallets can — but devnet test-tokens have no monetary value, so sybil resistance is explicitly not a goal.
- **In-memory** (`Map<wallet, lastClaimedMs>`). A process restart resets everyone's cooldown. For production this would be replaced with a durable store (SQLite, Redis, whatever the deployment stack uses).
- **Cooldown is enforced on the NEXT attempt**, not retroactively. If `COOLDOWN_MINUTES` is raised between requests, already-cooldown'd wallets don't get bumped; they only have to wait the remainder of whatever window was active at their last claim.

## Security

- The faucet keypair holds real mint authority for the `$FLIP` test mint (current authority pubkey: `5vzyxxJ1NwoN5PgX1p2zCavbxc7mugLMdF7At5syGfA6`, transferred from the operator's CLI wallet 2026-04-15). If leaked, an attacker can mint unlimited test-`$FLIP`. For **devnet** this is annoying but inert — the test mint has no monetary value. For **any future mainnet-equivalent faucet** the mint authority MUST be a dedicated keypair with minimal SOL, stored out-of-band, and rotated on any compromise. The keypair file MUST be backed up to a password manager **before** transferring authority — once `spl-token authorize` runs, the new authority is the only path to mint, and losing the file before backup strands the mint forever.
- CORS is locked to `ALLOWED_ORIGINS`. A misconfigured origin list is the silent way the faucet gets drained from a third-party site; review it before deploying.
- No rate-limit layer above per-wallet. For mainnet-adjacent usage add IP-based limits, reCAPTCHA, or behind-a-gateway rate-limiting. Tracked as "out of scope for devnet" above.

## What's NOT in scope

- **Gasless joinRound.** The faucet mints `$FLIP` and creates the ATA. It does NOT fund the user's wallet with SOL for their own future transactions. Users still need devnet SOL to call `joinRound` themselves. For devnet this is a 30-second detour to `faucet.solana.com`; for mainnet-equivalent UX you'd want a separate sponsored-tx mechanism.
- **Multi-game scope.** One service per deployment instance. Running 10 games = 1 faucet, shared across all of them.
- **Metrics / Prometheus.** Endpoints + logging are minimal. Add these in the same pass that deploys the faucet to production alongside the dealer (see [wiki / operations / dealer-runbook.md](../docs/wiki/operations/dealer-runbook.md) for the stack).
