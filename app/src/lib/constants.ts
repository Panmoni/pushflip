/**
 * Frontend-only constants. The on-chain constants (PUSHFLIP_PROGRAM_ID,
 * TOKEN_PROGRAM_ID, instruction discriminators, account discriminators) are
 * re-exported from `@pushflip/client` to keep one source of truth.
 *
 * Anything in this file is purely a frontend concern: RPC URLs, the default
 * game id the UI binds to, network selection, etc.
 */


/**
 * Devnet RPC HTTP endpoint. Used by both the wallet adapter's
 * ConnectionProvider (web3.js v1) and Kit's `createSolanaRpc(devnet(...))`.
 *
 * Override at build time via `VITE_RPC_ENDPOINT` if you want to point at a
 * private RPC (Helius, Triton, etc.). The smoke tests use the public devnet
 * endpoint by default; expect rate limiting under load.
 *
 * Note: `||` (not `??`) is intentional — `??` only catches `null`/`undefined`,
 * but a developer who sets `VITE_RPC_ENDPOINT=` (empty value) in `.env.local`
 * gets back an empty string, which silently breaks `createSolanaRpc(...)`.
 */
export const RPC_ENDPOINT: string =
  import.meta.env.VITE_RPC_ENDPOINT?.trim() || "https://api.devnet.solana.com";

/**
 * Devnet RPC WebSocket endpoint. Derived from `RPC_ENDPOINT` by mapping
 * `https://` → `wss://` and `http://` → `ws://`. Case-insensitive scheme
 * detection so `Https://...` is handled the same as `https://...`.
 */
const HTTPS_SCHEME = /^https/i;
const HTTP_SCHEME = /^http/i;

function deriveWsEndpoint(httpEndpoint: string): string {
  if (HTTPS_SCHEME.test(httpEndpoint)) {
    return httpEndpoint.replace(HTTPS_SCHEME, "wss");
  }
  if (HTTP_SCHEME.test(httpEndpoint)) {
    return httpEndpoint.replace(HTTP_SCHEME, "ws");
  }
  // Already a ws:// or wss:// URL, or something exotic — pass through.
  return httpEndpoint;
}

export const RPC_WS_ENDPOINT: string =
  import.meta.env.VITE_RPC_WS_ENDPOINT?.trim() ||
  deriveWsEndpoint(RPC_ENDPOINT);

/**
 * Test `$FLIP` mint on devnet. Re-exported from `@pushflip/client` so
 * there is exactly one source of truth; no hardcoding here.
 * (16th heavy-duty review M1 — previously triplicated across the app,
 * the faucet, and `scripts/devnet-config.ts`.)
 */
export { TEST_FLIP_MINT as TOKEN_MINT } from "@pushflip/client";

/**
 * Default game id the UI binds to. Phase 3.1 ships with a single hardcoded
 * game; multi-game discovery is a Task 3.7 polish item.
 *
 * - `1n` — original test-mode game, `vault_ready=false`. PDA
 *   `Hk6RLHBZ8oppV4KtQFFRsHC21z9tCL5HYz3cLELEA64A`. Preserved for
 *   the historical first-wallet-signed-joinRound record.
 * - `2n` — real-stake-mode game, `vault_ready=true` (flipped
 *   2026-04-12 via `scripts/init-vault.ts`). PDA
 *   `6CJNFykqYCD7UWVQdijLzUvco78nJB6TDqdJcaSP1rCr`. Every joinRound
 *   triggers an actual SPL Token transfer from the player's ATA to
 *   the vault.
 */
export const GAME_ID = 2n;
