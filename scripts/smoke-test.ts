/**
 * Devnet smoke test — Task 3.0 + Task 2.10 regression guard.
 *
 * Exercises the full happy path of the deployed pushflip program against
 * the real Solana devnet validator. The critical step is `hit`, which
 * runs `verify_merkle_proof` over a real Poseidon Merkle tree. As of
 * Task 2.10 (2026-04-09) Poseidon is computed via the native
 * `sol_poseidon` syscall (see `program/src/zk/poseidon_native.rs`); this
 * test is now the regression guard that catches anyone re-introducing the
 * `light_poseidon` stack-frame issue or breaking byte compatibility with
 * the dealer's circomlibjs Poseidon.
 *
 * Flow:
 *   1. Initialize a fresh game with random game_id
 *   2. Two ephemeral players join (no SPL token transfer — vault_ready=false)
 *   3. Dealer shuffles, generates Groth16 proof, commits deck
 *   4. Authority starts the round
 *   5. Player A calls hit() with leaf 0 — THIS HITS POSEIDON
 *   6. Verify the player's hand contains the revealed card
 *   7. Close the game (recovers rent)
 *
 * No SPL token mint is needed because join_round only transfers tokens
 * when `vault_ready` (the vault PDA must exist as a token account). We
 * pass the vault PDA address but never create a token account at it,
 * so vault_ready=false and the player joins with staked_amount=0.
 *
 * Run with: pnpm --filter @pushflip/scripts smoke-test
 */

import {
  type Address,
  type KeyPairSigner,
  appendTransactionMessageInstruction,
  generateKeyPairSigner,
  lamports,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { getTransferSolInstruction } from "@solana-program/system";

import {
  type PlayerState,
  decodeGameSession,
  decodePlayerState,
  deriveGamePda,
  derivePlayerPda,
  deriveVaultPda,
  getCloseGameInstruction,
  getCommitDeckInstruction,
  getEndRoundInstruction,
  getHitInstruction,
  getInitializeInstruction,
  getJoinRoundInstruction,
  getLeaveGameInstruction,
  getStartRoundInstruction,
  getStayInstruction,
  PUSHFLIP_PROGRAM_ID,
} from "@pushflip/client";
import { Dealer } from "@pushflip/dealer";

import { resolve } from "node:path";

import {
  type RpcContext,
  assertCuBudget,
  c,
  fail,
  info,
  loadCliKeypair,
  makeDevnetContext,
  ok,
  randomGameId,
  retry,
  sendTx,
  step,
} from "./lib/script-helpers";

// --- Config ---

const REPO_ROOT = resolve(import.meta.dirname, "..");
const ZK_BUILD_DIR = resolve(REPO_ROOT, "zk-circuits/build");
const DEALER_CONFIG = {
  wasmPath: resolve(ZK_BUILD_DIR, "shuffle_verify_js/shuffle_verify.wasm"),
  zkeyPath: resolve(ZK_BUILD_DIR, "shuffle_verify_final.zkey"),
  vkeyPath: resolve(ZK_BUILD_DIR, "verification_key.json"),
};

// Lamports each ephemeral player needs:
//   - PlayerState rent: ~0.00267 SOL (256-byte account, refunded on leave_game)
//   - A few tx fees per player (~3-4 instructions × 5000 lamports each)
//   - Buffer for the dealer's commit_deck tx
// 0.005 SOL is plenty even after the 3.A.1 extension (stay/end_round/
// leave_game) because rent comes back when leave_game closes the
// PlayerState before the player ever needs to spend it.
const PLAYER_FUNDING_LAMPORTS = 5_000_000n; // 0.005 SOL per player

// Compute budget for instructions that touch Poseidon. The default 200K is
// known to be tight for both commit_deck (Groth16 verification) and hit
// (Poseidon Merkle verification).
const HIT_COMPUTE_LIMIT = 400_000;
const COMMIT_DECK_COMPUTE_LIMIT = 400_000;

// CU regression budgets (Pre-Mainnet 5.0.9 PR 1 step 4). Empirically on
// devnet post-PR 1 log emission:
//   - commit_deck ~86K CU  (Groth16 verification dominates, variable)
//   - hit         ~9.5K CU (Poseidon Merkle verify, stable — Lesson 2.10)
// Budgets give ~25% headroom on hit (tight — Poseidon is stable, so
// regressions are almost always a real problem) and ~55% on commit_deck
// (loose — Groth16 wallclock cost varies with proof structure, and the
// 200K fits comfortably inside the 400K tx compute limit either way). A
// failure past these means someone re-introduced light_poseidon, broke
// the Groth16 path, or pushed log emission past budget. Tighten as the
// baseline stabilizes.
const COMMIT_DECK_CU_BUDGET = 200_000;
const HIT_CU_BUDGET = 12_000;

// --- Main ---

async function main(): Promise<void> {
  console.log(`${c.bold}${c.blue}╔════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}${c.blue}║  PushFlip Devnet Smoke Test (Task 3.0)             ║${c.reset}`);
  console.log(`${c.bold}${c.blue}╚════════════════════════════════════════════════════╝${c.reset}`);
  console.log(`${c.dim}Program: ${PUSHFLIP_PROGRAM_ID}${c.reset}`);
  console.log(`${c.dim}Cluster: devnet${c.reset}`);

  const ctx: RpcContext = makeDevnetContext();
  const { rpc } = ctx;

  // --- Setup: load wallet, generate ephemeral keys ---
  step(0, "Load wallet and generate ephemeral keypairs");
  const wallet = await loadCliKeypair();
  info(`Wallet: ${wallet.address}`);

  const dealerSigner = await generateKeyPairSigner();
  const playerA = await generateKeyPairSigner();
  const playerB = await generateKeyPairSigner();
  const houseAddr = await generateKeyPairSigner(); // identity only, never signs
  const treasuryAddr = await generateKeyPairSigner(); // identity only
  const tokenMintAddr = await generateKeyPairSigner(); // placeholder, vault_ready=false
  ok(`dealer:    ${dealerSigner.address}`);
  ok(`player A:  ${playerA.address}`);
  ok(`player B:  ${playerB.address}`);
  info(`(House identity: ${houseAddr.address} — never used as signer)`);

  // --- Step 1: Fund ephemeral keypairs ---
  step(1, "Fund ephemeral accounts from local wallet");
  const fundIxs = [dealerSigner, playerA, playerB].map((kp) =>
    getTransferSolInstruction({
      source: wallet,
      destination: kp.address,
      amount: PLAYER_FUNDING_LAMPORTS,
    }),
  );
  const fundSig = await sendTx(ctx, wallet, fundIxs);
  ok(`Funded 3 accounts with ${PLAYER_FUNDING_LAMPORTS} lamports each`);
  info(`tx: ${fundSig}`);

  // --- Step 2: Initialize game ---
  step(2, "Initialize game session");
  const gameId = randomGameId();
  const [gamePda, gameBump] = await deriveGamePda(gameId);
  const [vaultPda, vaultBump] = await deriveVaultPda(gamePda);
  info(`game_id:    ${gameId}`);
  info(`game PDA:   ${gamePda}`);
  info(`vault PDA:  ${vaultPda} (no token account — vault_ready will be false)`);

  const initIx = getInitializeInstruction(
    {
      authority: wallet.address,
      gameSession: gamePda,
      house: houseAddr.address,
      dealer: dealerSigner.address,
      treasury: treasuryAddr.address,
      tokenMint: tokenMintAddr.address,
    },
    { gameId, bump: gameBump, vaultBump, treasuryFeeBps: 200 },
  );
  const initSig = await sendTx(ctx, wallet, [initIx]);
  ok("Game initialized");
  info(`tx: ${initSig}`);

  // Verify state
  const gsAccount0 = await rpc.getAccountInfo(gamePda, { encoding: "base64" }).send();
  if (!gsAccount0.value) fail("GameSession account not found after init");
  const gs0 = decodeGameSession(
    Buffer.from(gsAccount0.value.data[0], "base64"),
  );
  if (gs0.playerCount !== 0) fail(`Expected playerCount=0, got ${gs0.playerCount}`);
  ok(`playerCount = 0 (initialize no longer pre-adds House — design fix verified live)`);

  // --- Step 3: Players A and B join ---
  step(3, "Both players join");
  const [psA, bumpA] = await derivePlayerPda(gameId, playerA.address);
  const [psB, bumpB] = await derivePlayerPda(gameId, playerB.address);
  info(`PS A: ${psA}`);
  info(`PS B: ${psB}`);

  // Player A joins. We pass the vault PDA as the vault account, but since
  // there is no token account at that address, vault_ready=false and no
  // transfer happens. Same for the player_token_account placeholder.
  const joinAIx = getJoinRoundInstruction(
    {
      gameSession: gamePda,
      playerState: psA,
      player: playerA.address,
      playerTokenAccount: playerA.address, // placeholder, never read
      vault: vaultPda,
    },
    // The MIN_STAKE check runs unconditionally, but the transfer + pot
    // increment are gated on vault_ready. With vault_ready=false, this
    // value is validated but no actual tokens move.
    { bump: bumpA, stakeAmount: 100_000_000_000n },
  );
  const joinASig = await sendTx(ctx, playerA, [joinAIx], [playerA]);
  ok(`Player A joined`);
  info(`tx: ${joinASig}`);

  const joinBIx = getJoinRoundInstruction(
    {
      gameSession: gamePda,
      playerState: psB,
      player: playerB.address,
      playerTokenAccount: playerB.address, // placeholder
      vault: vaultPda,
    },
    { bump: bumpB, stakeAmount: 100_000_000_000n },
  );
  const joinBSig = await sendTx(ctx, playerB, [joinBIx], [playerB]);
  ok(`Player B joined`);
  info(`tx: ${joinBSig}`);

  // Verify both player slots
  const gsAccount1 = await rpc.getAccountInfo(gamePda, { encoding: "base64" }).send();
  const gs1 = decodeGameSession(Buffer.from(gsAccount1.value!.data[0], "base64"));
  if (gs1.playerCount !== 2) fail(`Expected playerCount=2, got ${gs1.playerCount}`);
  ok(`playerCount = 2; turn_order = [${gs1.turnOrder[0]}, ${gs1.turnOrder[1]}]`);

  // --- Step 4: Dealer shuffles and commits deck ---
  step(4, "Dealer shuffles, generates Groth16 proof, commits deck");
  console.log(`  ${c.dim}(this takes ~30 seconds for proof generation)${c.reset}`);
  const dealer = new Dealer(DEALER_CONFIG);
  const t0 = Date.now();
  await dealer.shuffle();
  const proofMs = Date.now() - t0;
  ok(`Proof generated in ${proofMs}ms`);

  const proof = dealer.getSerializedProof();
  const merkleRoot = dealer.getMerkleRoot();
  info(`merkle root (hex): 0x${Buffer.from(merkleRoot).toString("hex").slice(0, 32)}...`);

  const commitIx = getCommitDeckInstruction(
    { gameSession: gamePda, dealer: dealerSigner.address },
    {
      merkleRoot,
      proofA: proof.proofA,
      proofB: proof.proofB,
      proofC: proof.proofC,
    },
  );
  // Bump compute budget — Groth16 verification uses ~200K CU plus overhead
  const commitCuIx = getSetComputeUnitLimitInstruction({ units: COMMIT_DECK_COMPUTE_LIMIT });
  const commitSig = await sendTx(ctx, dealerSigner, [commitCuIx, commitIx], [dealerSigner]);
  await assertCuBudget(rpc, commitSig, "commit_deck", COMMIT_DECK_CU_BUDGET);
  ok("Deck committed (Groth16 proof verified on-chain)");
  info(`tx: ${commitSig}`);

  // --- Step 5: Authority starts the round ---
  step(5, "Authority starts the round");
  const startIx = getStartRoundInstruction({
    gameSession: gamePda,
    authority: wallet.address,
    playerStates: [psA, psB],
  });
  const startSig = await sendTx(ctx, wallet, [startIx]);
  ok("Round started");
  info(`tx: ${startSig}`);

  const gsAccount2 = await rpc.getAccountInfo(gamePda, { encoding: "base64" }).send();
  const gs2 = decodeGameSession(Buffer.from(gsAccount2.value!.data[0], "base64"));
  if (!gs2.roundActive) fail("round_active should be true");
  if (gs2.currentTurnIndex !== 0) fail(`Expected currentTurnIndex=0, got ${gs2.currentTurnIndex}`);
  ok(`round_active = true, currentTurnIndex = 0 (player A's turn)`);

  // --- Step 6: Player A hits — THE CRITICAL TEST ---
  step(6, "Player A calls hit() — exercises sol_poseidon syscall + Merkle verify");
  console.log(
    `  ${c.dim}Regression guard for Task 2.10. If this fails with a stack overflow,${c.reset}`,
  );
  console.log(
    `  ${c.dim}someone has re-introduced light_poseidon into the BPF binary.${c.reset}`,
  );

  const reveal = dealer.revealNextCard();
  info(`Card revealed by dealer: value=${reveal.card.value} type=${reveal.card.cardType} suit=${reveal.card.suit}`);
  info(`leaf_index = ${reveal.leafIndex}`);
  info(`merkle proof: 7 sibling hashes (224 bytes)`);

  const hitIx = getHitInstruction(
    {
      gameSession: gamePda,
      playerState: psA,
      player: playerA.address,
    },
    {
      cardValue: reveal.card.value,
      cardType: reveal.card.cardType,
      cardSuit: reveal.card.suit,
      merkleProof: reveal.proof,
      leafIndex: reveal.leafIndex,
    },
  );
  const hitCuIx = getSetComputeUnitLimitInstruction({ units: HIT_COMPUTE_LIMIT });

  let hitSig: string;
  try {
    hitSig = await sendTx(ctx, playerA, [hitCuIx, hitIx], [playerA]);
    await assertCuBudget(rpc, hitSig, "hit (player A)", HIT_CU_BUDGET);
  } catch (e) {
    console.log(`\n  ${c.red}${c.bold}✗ HIT FAILED${c.reset}`);
    const err = e as Error & { context?: { logs?: string[] }; cause?: Error & { context?: { code?: number } } };
    console.log(`  ${c.red}Error: ${err.message}${c.reset}`);
    if (err.cause?.context?.code !== undefined) {
      console.log(`  ${c.red}Custom program error code: ${err.cause.context.code} (0x${err.cause.context.code.toString(16)})${c.reset}`);
    }
    if (err.context?.logs) {
      console.log(`  ${c.red}Program logs:${c.reset}`);
      for (const line of err.context.logs) {
        console.log(`    ${c.dim}${line}${c.reset}`);
      }
    }
    console.log(
      `\n  ${c.yellow}If the error mentions a stack overflow, the BPF binary may have${c.reset}`,
    );
    console.log(
      `  ${c.yellow}re-introduced light_poseidon. See docs/POSEIDON_STACK_WARNING.md.${c.reset}`,
    );
    process.exit(2);
  }

  ok("hit() succeeded — sol_poseidon syscall + Merkle verify worked end-to-end");
  info(`tx: ${hitSig}`);

  // --- Step 7: Verify hand state ---
  step(7, "Verify revealed card is in player A's hand");
  const psAccount = await rpc.getAccountInfo(psA, { encoding: "base64" }).send();
  if (!psAccount.value) fail("PlayerState A not found");
  const psState: PlayerState = decodePlayerState(
    Buffer.from(psAccount.value.data[0], "base64"),
  );
  if (psState.handSize !== 1) fail(`Expected handSize=1, got ${psState.handSize}`);
  const card = psState.hand[0];
  if (
    card.value !== reveal.card.value ||
    card.cardType !== reveal.card.cardType ||
    card.suit !== reveal.card.suit
  ) {
    fail(
      `Hand card mismatch! Expected (${reveal.card.value},${reveal.card.cardType},${reveal.card.suit}), got (${card.value},${card.cardType},${card.suit})`,
    );
  }
  ok(`Hand contains the revealed card: value=${card.value} type=${card.cardType} suit=${card.suit}`);

  // Player A might already be inactive after the hit (if they busted on
  // their first card — possible with a duplicate value or a bust effect).
  // Track the active state explicitly so the rest of the flow handles
  // either case correctly.
  let playerAActive = psState.isActive;
  info(`player A active after hit: ${playerAActive}`);

  // --- Step 7b: Player A stays (only if still active) ---
  if (playerAActive) {
    step(7.5, "Player A calls stay() to lock in their score");
    const stayAIx = getStayInstruction({
      gameSession: gamePda,
      playerState: psA,
      player: playerA.address,
    });
    const stayASig = await sendTx(ctx, playerA, [stayAIx], [playerA]);
    ok(`Player A stayed`);
    info(`tx: ${stayASig}`);
    playerAActive = false;
  } else {
    info(`(player A already inactive — no stay needed)`);
  }

  // --- Step 7c: Verify it's now player B's turn, then player B stays ---
  step(8, "Player B's turn — hit once then stay");

  const gsAccountTurn = await rpc.getAccountInfo(gamePda, { encoding: "base64" }).send();
  const gsTurn = decodeGameSession(Buffer.from(gsAccountTurn.value!.data[0], "base64"));
  if (gsTurn.currentTurnIndex !== 1) {
    fail(`Expected currentTurnIndex=1 (player B), got ${gsTurn.currentTurnIndex}`);
  }
  ok(`turn advanced: currentTurnIndex = 1 (player B)`);

  // Player B hits once
  const revealB = dealer.revealNextCard();
  info(`Card revealed by dealer for B: value=${revealB.card.value} type=${revealB.card.cardType} suit=${revealB.card.suit}`);
  const hitBIx = getHitInstruction(
    {
      gameSession: gamePda,
      playerState: psB,
      player: playerB.address,
    },
    {
      cardValue: revealB.card.value,
      cardType: revealB.card.cardType,
      cardSuit: revealB.card.suit,
      merkleProof: revealB.proof,
      leafIndex: revealB.leafIndex,
    },
  );
  const hitBCuIx = getSetComputeUnitLimitInstruction({ units: HIT_COMPUTE_LIMIT });
  const hitBSig = await sendTx(ctx, playerB, [hitBCuIx, hitBIx], [playerB]);
  ok(`Player B hit succeeded`);
  info(`tx: ${hitBSig}`);

  // Check if player B is still active (might have busted)
  const psBAccount = await rpc.getAccountInfo(psB, { encoding: "base64" }).send();
  const psBState = decodePlayerState(Buffer.from(psBAccount.value!.data[0], "base64"));
  let playerBActive = psBState.isActive;
  info(`player B active after hit: ${playerBActive}`);

  if (playerBActive) {
    const stayBIx = getStayInstruction({
      gameSession: gamePda,
      playerState: psB,
      player: playerB.address,
    });
    const stayBSig = await sendTx(ctx, playerB, [stayBIx], [playerB]);
    ok(`Player B stayed`);
    info(`tx: ${stayBSig}`);
    playerBActive = false;
  } else {
    info(`(player B already inactive — no stay needed)`);
  }

  // --- Step 9: Authority calls end_round ---
  step(9, "Authority calls end_round() — settles the round");
  info(`(no token payout: vault_ready=false in this run, so end_round only updates state)`);

  // The authority is the caller. End_round needs the vault, winner token
  // account, treasury token account, and player_states in turn_order. Since
  // vault_ready=false, no transfers fire, so we can pass placeholders for
  // the token accounts (they're never read by the no-payout code path).
  const endRoundIx = getEndRoundInstruction({
    gameSession: gamePda,
    caller: wallet.address,
    vault: vaultPda,
    winnerTokenAccount: wallet.address, // placeholder, vault_ready=false
    treasuryTokenAccount: wallet.address, // placeholder, vault_ready=false
    playerStates: [psA, psB],
  });
  const endRoundSig = await sendTx(ctx, wallet, [endRoundIx]);
  ok(`Round ended`);
  info(`tx: ${endRoundSig}`);

  const gsAfterEnd = decodeGameSession(
    Buffer.from(
      (await rpc.getAccountInfo(gamePda, { encoding: "base64" }).send()).value!.data[0],
      "base64",
    ),
  );
  if (gsAfterEnd.roundActive) fail(`round_active should be false after end_round, got true`);
  if (gsAfterEnd.deckCommitted) fail(`deck_committed should be false after end_round, got true`);
  if (gsAfterEnd.drawCounter !== 0) fail(`draw_counter should be 0 after end_round, got ${gsAfterEnd.drawCounter}`);
  ok(`GameSession state reset: round_active=false, deck_committed=false, draw_counter=0`);

  // --- Step 10: Player B leaves the game between rounds ---
  // Verifies the leave_game between-rounds path:
  //   - Compacts turn_order
  //   - Decrements player_count
  //   - Closes PlayerState PDA
  //   - Refunds rent to the player
  step(10, "Player B calls leave_game() — exercises between-rounds leave path");

  // Use getBalance instead of getAccountInfo: it's lamport-only and skips
  // the JSON-RPC default base58 encoding which fails on data > 128 bytes
  // (PlayerState is 256 bytes).
  const playerBLamportsBefore = await retry("getBalance(playerB) pre-leave", () =>
    rpc.getBalance(playerB.address).send().then((r) => r.value),
  );
  const psBLamportsBefore = await retry("getBalance(psB) pre-leave", () =>
    rpc.getBalance(psB).send().then((r) => r.value),
  );
  info(`player B balance before leave: ${playerBLamportsBefore} lamports`);
  info(`PlayerState B rent: ${psBLamportsBefore} lamports`);

  const leaveBIx = getLeaveGameInstruction({
    gameSession: gamePda,
    playerState: psB,
    player: playerB.address,
    recipient: playerB.address,
  });
  const leaveBSig = await sendTx(ctx, playerB, [leaveBIx], [playerB]);
  ok(`Player B left the game`);
  info(`tx: ${leaveBSig}`);

  // PlayerState B should be gone. Pass encoding=base64 so the call
  // doesn't fail with the base58>128B error if the account somehow
  // still exists.
  const psBAfterLeave = await retry("getAccountInfo(psB) post-leave", () =>
    rpc.getAccountInfo(psB, { encoding: "base64" }).send(),
  );
  if (psBAfterLeave.value !== null) fail(`PlayerState B should be closed, but still exists`);
  ok(`PlayerState B PDA closed`);

  // GameSession should now have player_count=1 with player A in slot 0
  const gsAfterLeave = decodeGameSession(
    Buffer.from(
      (
        await retry("getAccountInfo(gamePda) post-leaveB", () =>
          rpc.getAccountInfo(gamePda, { encoding: "base64" }).send(),
        )
      ).value!.data[0],
      "base64",
    ),
  );
  if (gsAfterLeave.playerCount !== 1) {
    fail(`Expected playerCount=1 after B leaves, got ${gsAfterLeave.playerCount}`);
  }
  if (gsAfterLeave.turnOrder[0] !== playerA.address) {
    fail(`Expected turnOrder[0]=playerA, got ${gsAfterLeave.turnOrder[0]}`);
  }
  ok(`turn_order compacted: playerCount=1, turnOrder[0]=playerA`);

  // Player B's lamport balance should have increased by the PlayerState
  // rent minus the leave_game tx fee (5000 lamports).
  const playerBLamportsAfter = await retry("getBalance(playerB) post-leave", () =>
    rpc.getBalance(playerB.address).send().then((r) => r.value),
  );
  const lamportsDelta = playerBLamportsAfter - playerBLamportsBefore;
  const expectedDelta = psBLamportsBefore - 5000n; // rent minus tx fee
  info(`player B balance after leave: ${playerBLamportsAfter} lamports (delta: ${lamportsDelta >= 0n ? "+" : ""}${lamportsDelta})`);
  if (lamportsDelta !== expectedDelta) {
    fail(
      `Rent refund off! Expected delta=${expectedDelta} (rent ${psBLamportsBefore} - tx fee 5000), got ${lamportsDelta}`,
    );
  }
  ok(`Rent refund verified: +${lamportsDelta} lamports`);

  // --- Step 11: Player A also leaves so we can close the game ---
  // The close_game instruction requires player_count == 0 OR no players
  // referenced — actually it just needs round_active=false and pot_amount=0,
  // which we already have. But for clean rent recovery we leave A too so
  // their PlayerState gets reclaimed before we close the GameSession.
  step(11, "Player A leaves between rounds — also exercises leave_game from the only-player slot");

  const psALamportsBefore = (await rpc.getBalance(psA).send()).value;
  const leaveAIx = getLeaveGameInstruction({
    gameSession: gamePda,
    playerState: psA,
    player: playerA.address,
    recipient: playerA.address,
  });
  const leaveASig = await sendTx(ctx, playerA, [leaveAIx], [playerA]);
  ok(`Player A left the game`);
  info(`tx: ${leaveASig}`);

  const psAAfterLeave = await retry("getAccountInfo(psA) post-leave", () =>
    rpc.getAccountInfo(psA, { encoding: "base64" }).send(),
  );
  if (psAAfterLeave.value !== null) fail(`PlayerState A should be closed`);

  const gsAfterLeaveA = decodeGameSession(
    Buffer.from(
      (
        await retry("getAccountInfo(gamePda) post-leaveA", () =>
          rpc.getAccountInfo(gamePda, { encoding: "base64" }).send(),
        )
      ).value!.data[0],
      "base64",
    ),
  );
  if (gsAfterLeaveA.playerCount !== 0) {
    fail(`Expected playerCount=0 after A leaves, got ${gsAfterLeaveA.playerCount}`);
  }
  ok(`PlayerState A PDA closed; GameSession now has playerCount=0`);
  void psALamportsBefore; // (recorded above for symmetry but we trust the assertion above too)

  // --- Step 12: Authority closes the game and recovers rent ---
  step(12, "Authority calls close_game() — recovers GameSession rent");

  const walletLamportsBefore = await retry("getBalance(wallet) pre-close", () =>
    rpc.getBalance(wallet.address).send().then((r) => r.value),
  );
  const gsLamportsBefore = await retry("getBalance(gamePda) pre-close", () =>
    rpc.getBalance(gamePda).send().then((r) => r.value),
  );
  info(`wallet balance before close: ${walletLamportsBefore} lamports`);
  info(`GameSession rent: ${gsLamportsBefore} lamports`);

  const closeGameIx = getCloseGameInstruction({
    gameSession: gamePda,
    authority: wallet.address,
    recipient: wallet.address,
  });
  const closeSig = await sendTx(ctx, wallet, [closeGameIx]);
  ok(`Game closed`);
  info(`tx: ${closeSig}`);

  // GameSession PDA should be gone
  const gsAfterClose = await retry("getAccountInfo(gamePda) post-close", () =>
    rpc.getAccountInfo(gamePda, { encoding: "base64" }).send(),
  );
  if (gsAfterClose.value !== null) fail(`GameSession should be closed, but still exists`);
  ok(`GameSession PDA closed`);

  const walletLamportsAfter = await retry("getBalance(wallet) post-close", () =>
    rpc.getBalance(wallet.address).send().then((r) => r.value),
  );
  const walletDelta = walletLamportsAfter - walletLamportsBefore;
  // Authority got back GameSession rent but paid the close_game tx fee.
  const expectedWalletDelta = gsLamportsBefore - 5000n;
  if (walletDelta !== expectedWalletDelta) {
    fail(
      `Authority rent refund off! Expected ${expectedWalletDelta}, got ${walletDelta}`,
    );
  }
  ok(`Authority rent refund verified: +${walletDelta} lamports`);

  // --- Final summary ---
  console.log(`\n${c.bold}${c.green}╔════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}${c.green}║  ✓ SMOKE TEST PASSED                               ║${c.reset}`);
  console.log(`${c.bold}${c.green}╚════════════════════════════════════════════════════╝${c.reset}`);
  console.log(`\n${c.bold}Verified empirically on devnet:${c.reset}`);
  console.log(`  ${c.green}✓${c.reset} Full game lifecycle: initialize → join (×2) → commit_deck → start_round → hit → stay → end_round → leave_game → close_game`);
  console.log(`  ${c.green}✓${c.reset} Groth16 proof verification on real alt_bn128 syscalls works`);
  console.log(`  ${c.green}✓${c.reset} ${c.bold}sol_poseidon syscall + Merkle proof verification work on the real validator${c.reset}`);
  console.log(`  ${c.green}✓${c.reset} Card data round-trip: dealer → on-chain → client deserialize`);
  console.log(`  ${c.green}✓${c.reset} The initialize design fix (no auto-add House) holds on real validator`);
  console.log(`  ${c.green}✓${c.reset} Turn advancement (hit → stay → next player) works on real validator`);
  console.log(`  ${c.green}✓${c.reset} end_round (no-payout path) settles state correctly`);
  console.log(`  ${c.green}✓${c.reset} leave_game (between-rounds) closes PlayerState and refunds rent exactly`);
  console.log(`  ${c.green}✓${c.reset} close_game closes GameSession and refunds rent exactly`);
  console.log(`\n${c.dim}Game and all PlayerStates fully cleaned up. No on-chain residue.${c.reset}`);
  console.log(`${c.dim}game_id: ${gameId}${c.reset}\n`);
}

main()
  .then(() => process.exit(0)) // force-exit so an open WSS handle doesn't keep us alive
  .catch((e) => {
    console.error(`\n${c.red}${c.bold}Smoke test crashed:${c.reset}`);
    console.error(e);
    process.exit(1);
  });
