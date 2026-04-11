/**
 * Initialize a single GameSession on devnet at a fixed `game_id` (default 1).
 *
 * Unlike `smoke-test.ts` (which runs the full lifecycle and then closes the
 * game in the final step), this script ONLY runs the Initialize instruction
 * and stops. The result is a persistent, freshly-initialized GameSession
 * account that the frontend can read against and that real wallets can
 * `joinRound` against from the browser.
 *
 * Why a separate script:
 *   - smoke-test.ts ends with `closeGame` (rent recovery) — running it
 *     against `game_id=1` would create the account and immediately destroy
 *     it.
 *   - The frontend (`app/src/lib/constants.ts:62`) hardcodes `GAME_ID = 1n`,
 *     so the read hooks (`useGameSession`, `usePlayerState`) need a real
 *     account at that PDA to populate.
 *   - First end-to-end test of the wallet adapter ↔ Kit signing bridge
 *     (Task 3.2) requires a joinable game on chain.
 *
 * Configuration choices for the test game:
 *   - `authority = dealer = house = treasury = wallet` — same CLI keypair
 *     fills every role. Authority is the wallet so the same key can later
 *     run `start_round`/`end_round`. Dealer is the wallet so a future
 *     `commit-deck.ts` script can sign as the dealer.
 *   - `tokenMint = TEST_FLIP_MINT` (the real devnet test mint) — kept for
 *     forward compatibility. The program checks `vault_ready` at runtime
 *     by looking for an SPL token account at the vault PDA; we don't
 *     create one, so vault_ready will resolve to false and join_round
 *     will validate `MIN_STAKE` but skip the actual token transfer. This
 *     is exactly what we want for the first wallet-bridge test: the
 *     on-chain effect is just "PlayerState created with staked_amount=0".
 *   - `treasury_fee_bps = 200` (2%) — matches smoke-test.ts.
 *
 * Idempotent: if the GameSession PDA already exists, the script prints its
 * current state and exits 0 without re-sending. Safe to re-run.
 *
 * Run with:
 *   pnpm --filter @pushflip/scripts init-game            # game_id=1
 *   GAME_ID=42 pnpm --filter @pushflip/scripts init-game # different id
 */

import {
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  devnet,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type KeyPairSigner,
} from "@solana/kit";

import {
  decodeGameSession,
  deriveGamePda,
  deriveVaultPda,
  getInitializeInstruction,
  PUSHFLIP_PROGRAM_ID,
} from "@pushflip/client";

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { TEST_FLIP_MINT } from "./devnet-config.js";

// --- Config ---

const DEVNET_RPC_URL = "https://api.devnet.solana.com";
const DEVNET_WS_URL = "wss://api.devnet.solana.com";

/**
 * Parse a u64 from a user-supplied decimal string.
 *
 * `BigInt(str)` is too permissive for u64 input: it silently accepts
 * `"0xff"` (hex → 255), `"-1"` (negative), and values beyond 2^64-1.
 * Worse, when those bigints are later passed through `setBigUint64`,
 * JavaScript silently *wraps*: `2n ** 64n` becomes `0n` (which would
 * collide with game_id=0), and `-1n` becomes `0xffff_ffff_ffff_ffffn`.
 *
 * Phase 3.2's heavy-duty review caught the same footgun in
 * `useGameActions.joinRound`'s stake validation. This guard mirrors
 * that fix so the same bug doesn't ship twice.
 *
 * Accepts: positive decimal integers in `[0, 2^64 - 1]`.
 * Rejects: hex prefixes, negative numbers, floats, scientific notation,
 *          empty strings, anything `BigInt()` can't parse, and values
 *          that would overflow u64 on the wire.
 */
const U64_MAX = 0xffff_ffff_ffff_ffffn;

function parseU64(raw: string, fieldName: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `Invalid ${fieldName}: ${JSON.stringify(raw)} — expected a positive decimal integer (no hex, no signs, no scientific notation)`,
    );
  }
  let parsed: bigint;
  try {
    parsed = BigInt(raw);
  } catch {
    throw new Error(`Invalid ${fieldName}: ${JSON.stringify(raw)}`);
  }
  if (parsed > U64_MAX) {
    throw new Error(
      `Invalid ${fieldName}: ${raw} exceeds u64 max (${U64_MAX})`,
    );
  }
  return parsed;
}

// `game_id` is u64. Default 1n to match `app/src/lib/constants.ts:62`.
// Override via env var for non-default ids: `GAME_ID=42 pnpm ...`.
const GAME_ID: bigint = (() => {
  const raw = process.env.GAME_ID?.trim();
  if (!raw) return 1n;
  return parseU64(raw, "GAME_ID env var");
})();

const TREASURY_FEE_BPS = 200; // 2%

// --- Tiny logging helpers (mirror smoke-test.ts style) ---

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function ok(msg: string): void {
  console.log(`  ${c.green}✓${c.reset} ${msg}`);
}
function info(msg: string): void {
  console.log(`  ${c.dim}${msg}${c.reset}`);
}
function step(n: number, label: string): void {
  console.log(`\n${c.bold}${c.cyan}[${n}]${c.reset} ${c.bold}${label}${c.reset}`);
}
function fail(msg: string): never {
  console.log(`  ${c.red}✗${c.reset} ${msg}`);
  process.exit(1);
}

/**
 * Print rich context for an RPC / transaction error: the program's
 * custom error code (if any) and the program logs (if any). Mirrors
 * the pattern in `scripts/smoke-test.ts:413-424`. Without this, on-chain
 * failures show up as cryptic error blobs and the program logs (which
 * are the only signal you actually need to debug them) are buried.
 */
function printRpcError(label: string, e: unknown): void {
  console.log(`\n  ${c.red}${c.bold}✗ ${label}${c.reset}`);
  const err = e as Error & {
    context?: { logs?: string[] };
    cause?: Error & { context?: { code?: number } };
  };
  console.log(`  ${c.red}Error: ${err.message ?? String(e)}${c.reset}`);
  if (err.cause?.context?.code !== undefined) {
    const code = err.cause.context.code;
    console.log(
      `  ${c.red}Custom program error code: ${code} (0x${code.toString(16)})${c.reset}`,
    );
  }
  if (err.context?.logs && err.context.logs.length > 0) {
    console.log(`  ${c.red}Program logs:${c.reset}`);
    for (const line of err.context.logs) {
      console.log(`    ${c.dim}${line}${c.reset}`);
    }
  }
}

// --- Wallet loading ---

async function loadCliKeypair(): Promise<KeyPairSigner> {
  const path = resolve(homedir(), ".config/solana/id.json");
  const bytes = new Uint8Array(JSON.parse(readFileSync(path, "utf-8")));
  return createKeyPairSignerFromBytes(bytes);
}

interface RpcContext {
  rpc: Rpc<SolanaRpcApi>;
  rpcSubs: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory>;
}

async function sendTx(
  ctx: RpcContext,
  feePayer: KeyPairSigner,
  instructions: Parameters<typeof appendTransactionMessageInstructions>[0],
): Promise<string> {
  const { value: blockhash } = await ctx.rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(signed);
  await ctx.sendAndConfirm(signed, { commitment: "confirmed" });
  return getSignatureFromTransaction(signed);
}

// --- Main ---

async function main(): Promise<void> {
  console.log(
    `${c.bold}${c.blue}╔════════════════════════════════════════════════════╗${c.reset}`,
  );
  console.log(
    `${c.bold}${c.blue}║  PushFlip — Initialize devnet game (game_id=${GAME_ID
      .toString()
      .padEnd(5)}) ║${c.reset}`,
  );
  console.log(
    `${c.bold}${c.blue}╚════════════════════════════════════════════════════╝${c.reset}`,
  );
  console.log(`${c.dim}Program: ${PUSHFLIP_PROGRAM_ID}${c.reset}`);
  console.log(`${c.dim}Cluster: devnet${c.reset}`);
  console.log(`${c.dim}Token mint: ${TEST_FLIP_MINT} (vault_ready will be false)${c.reset}`);

  const rpc = createSolanaRpc(devnet(DEVNET_RPC_URL));
  const rpcSubs = createSolanaRpcSubscriptions(devnet(DEVNET_WS_URL));
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: rpcSubs });
  const ctx: RpcContext = { rpc, rpcSubs, sendAndConfirm };

  // --- Load wallet ---
  step(0, "Load CLI wallet");
  const wallet = await loadCliKeypair();
  ok(`Wallet: ${wallet.address}`);

  // --- Derive PDAs ---
  step(1, "Derive PDAs");
  const [gamePda, gameBump] = await deriveGamePda(GAME_ID);
  const [vaultPda, vaultBump] = await deriveVaultPda(gamePda);
  info(`game_id:     ${GAME_ID}`);
  info(`game PDA:    ${gamePda} (bump ${gameBump})`);
  info(`vault PDA:   ${vaultPda} (bump ${vaultBump})`);

  // --- Idempotency check ---
  step(2, "Check if game already exists");
  const existing = await rpc.getAccountInfo(gamePda, { encoding: "base64" }).send();
  if (existing.value) {
    const gs = decodeGameSession(
      Buffer.from(existing.value.data[0], "base64"),
    );
    ok("Game already initialized — nothing to do");
    info(`playerCount:    ${gs.playerCount}`);
    info(`roundActive:    ${gs.roundActive}`);
    info(`deckCommitted:  ${gs.deckCommitted}`);
    info(`potAmount:      ${gs.potAmount}`);
    info(`treasuryFeeBps: ${gs.treasuryFeeBps}`);
    console.log(
      `\n${c.green}${c.bold}✓ Done.${c.reset} Game at ${gamePda} is ready for the frontend.\n`,
    );
    return;
  }
  info("Game does not exist yet — initializing");

  // --- Initialize ---
  step(3, "Send Initialize instruction");
  // Same wallet fills authority + dealer + house + treasury for simplicity.
  // tokenMint is the real test mint; vault_ready stays false because no
  // SPL token account exists at the vault PDA.
  const initIx = getInitializeInstruction(
    {
      authority: wallet.address,
      gameSession: gamePda,
      house: wallet.address,
      dealer: wallet.address,
      treasury: wallet.address,
      tokenMint: TEST_FLIP_MINT,
    },
    {
      gameId: GAME_ID,
      bump: gameBump,
      vaultBump,
      treasuryFeeBps: TREASURY_FEE_BPS,
    },
  );
  let sig: string;
  try {
    sig = await sendTx(ctx, wallet, [initIx]);
  } catch (e) {
    printRpcError("Initialize failed", e);
    process.exit(2);
  }
  ok("Initialize confirmed");
  info(`tx: ${sig}`);
  info(`https://explorer.solana.com/tx/${sig}?cluster=devnet`);

  // --- Verify ---
  step(4, "Verify GameSession state");
  const after = await rpc.getAccountInfo(gamePda, { encoding: "base64" }).send();
  if (!after.value) fail("GameSession account not found after Initialize");
  const gs = decodeGameSession(Buffer.from(after.value.data[0], "base64"));
  if (gs.playerCount !== 0)
    fail(`Expected playerCount=0, got ${gs.playerCount}`);
  ok(`playerCount = 0`);
  ok(`roundActive = ${gs.roundActive} (false expected)`);
  ok(`deckCommitted = ${gs.deckCommitted} (false expected)`);
  ok(`potAmount = ${gs.potAmount} (0 expected)`);
  ok(`treasuryFeeBps = ${gs.treasuryFeeBps} (${TREASURY_FEE_BPS} expected)`);
  info(
    `(vault_ready is determined at runtime by the program from the absence of a token account at the vault PDA — not stored on the GameSession)`,
  );

  console.log(
    `\n${c.green}${c.bold}✓ Done.${c.reset} GameSession at ${gamePda} is ready.\n`,
  );
  console.log(`${c.dim}Next: open the frontend, connect a wallet, and watch the read hooks populate.${c.reset}\n`);
}

main()
  .then(() => process.exit(0)) // force-exit so an open WSS handle doesn't keep us alive (mirrors smoke-test.ts:735)
  .catch((err) => {
    console.error(`\n${c.red}${c.bold}✗ init-game failed:${c.reset}`, err);
    process.exit(1);
  });
