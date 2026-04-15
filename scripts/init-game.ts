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
  decodeGameSession,
  deriveGamePda,
  deriveVaultPda,
  getInitializeInstruction,
  parseU64,
  PUSHFLIP_PROGRAM_ID,
} from "@pushflip/client";

import { TEST_FLIP_MINT } from "./devnet-config.js";

import {
  type RpcContext,
  c,
  fail,
  info,
  loadCliKeypair,
  makeDevnetContext,
  ok,
  printRpcError,
  sendTx,
  step,
} from "./lib/script-helpers";

// --- Config ---

// `game_id` is u64. Default 1n to match `app/src/lib/constants.ts:62`.
// Override via env var for non-default ids: `GAME_ID=42 pnpm ...`.
const GAME_ID: bigint = (() => {
  const raw = process.env.GAME_ID?.trim();
  if (!raw) return 1n;
  return parseU64(raw, "GAME_ID env var");
})();

const TREASURY_FEE_BPS = 200; // 2%

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

  const ctx: RpcContext = makeDevnetContext();
  const { rpc } = ctx;

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
