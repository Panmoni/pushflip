/**
 * Devnet bounty smoke test — Task 3.A.4.
 *
 * Exercises the four new bounty board instructions on a real validator:
 *   - init_bounty_board (12)
 *   - add_bounty        (13)
 *   - claim_bounty      (14)
 *   - close_bounty_board (15)
 *
 * Game flow used to engineer a claimable bounty:
 *
 *   1. Initialize game (vault_ready=false, no real $FLIP needed for this test)
 *   2. init_bounty_board
 *   3. add_bounty(SURVIVOR, reward=1000) — anyone who stays can claim
 *   4. add_bounty(HIGH_SCORE, threshold=100000) — score >= 100k needed
 *   5. Two players join, dealer commits, round starts
 *   6. Player A draws one card and stays  → SURVIVOR is now claimable
 *   7. Player A calls claim_bounty(0) — verifies SURVIVOR claim works
 *   8. (HIGH_SCORE is left unclaimed — neither player will hit 100k score
 *      with one card; this is intentional, it proves the win-condition
 *      check actually rejects ineligible claims when we try below)
 *   9. Player B draws and stays
 *   10. Try claim_bounty(1) — should FAIL (HIGH_SCORE not met) ← negative test
 *   11. end_round, leave_game ×2, close_bounty_board, close_game
 *
 * Acceptance:
 *   - Bounty 0 (SURVIVOR) is_active=false, claimed_by=playerA after step 7
 *   - Bounty 1 (HIGH_SCORE) is_active=true, unclaimed after step 10
 *   - close_bounty_board refunds rent to authority cleanly
 */

import {
  type Address,
  type Rpc,
  type SolanaRpcApi,
  generateKeyPairSigner,
  getAddressEncoder,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { getTransferSolInstruction } from "@solana-program/system";

import {
  decodeBountyBoard,
  deriveBountyPda,
  deriveGamePda,
  derivePlayerPda,
  deriveVaultPda,
  getAddBountyInstruction,
  getClaimBountyInstruction,
  getCloseBountyBoardInstruction,
  getCloseGameInstruction,
  getCommitDeckInstruction,
  getEndRoundInstruction,
  getHitInstruction,
  getInitBountyBoardInstruction,
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

/** SURVIVOR bounty type discriminator (matches state/bounty.rs). */
const SURVIVOR = 2;
/** HIGH_SCORE bounty type discriminator. */
const HIGH_SCORE = 1;

const PLAYER_FUNDING_LAMPORTS = 5_000_000n; // 0.005 SOL
const COMMIT_DECK_COMPUTE_LIMIT = 400_000;
const HIT_COMPUTE_LIMIT = 400_000;

// --- Helpers ---

async function readBountyBoard(rpc: Rpc<SolanaRpcApi>, addr: Address) {
  const acct = await retry(`getAccountInfo(${addr})`, () =>
    rpc.getAccountInfo(addr, { encoding: "base64" }).send(),
  );
  if (!acct.value) throw new Error(`BountyBoard ${addr} not found`);
  return decodeBountyBoard(Buffer.from(acct.value.data[0], "base64"));
}

// --- Main ---

async function main(): Promise<void> {
  console.log(`${c.bold}${c.blue}╔════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}${c.blue}║  PushFlip Bounty Board Smoke Test (Task 3.A.4)     ║${c.reset}`);
  console.log(`${c.bold}${c.blue}╚════════════════════════════════════════════════════╝${c.reset}`);
  console.log(`${c.dim}Program: ${PUSHFLIP_PROGRAM_ID}${c.reset}`);
  console.log(`${c.dim}Cluster: devnet${c.reset}`);

  const ctx: RpcContext = makeDevnetContext();
  const { rpc } = ctx;

  // --- Step 0: Setup ---
  step(0, "Load wallet and generate keypairs");
  const wallet = await loadCliKeypair();
  const dealerSigner = await generateKeyPairSigner();
  const playerA = await generateKeyPairSigner();
  const playerB = await generateKeyPairSigner();
  const houseAddr = await generateKeyPairSigner();
  const treasuryAddr = await generateKeyPairSigner();
  const tokenMintAddr = await generateKeyPairSigner();
  ok(`wallet:    ${wallet.address}`);
  ok(`player A:  ${playerA.address}`);
  ok(`player B:  ${playerB.address}`);

  // --- Step 1: Fund ---
  step(1, "Fund ephemeral accounts");
  const fundSig = await sendTx(
    ctx,
    wallet,
    [dealerSigner, playerA, playerB].map((kp) =>
      getTransferSolInstruction({
        source: wallet,
        destination: kp.address,
        amount: PLAYER_FUNDING_LAMPORTS,
      }),
    ),
  );
  ok(`Funded — tx: ${fundSig}`);

  // --- Step 2: Initialize game (vault_ready=false) ---
  step(2, "Initialize game (no real tokens needed for this test)");
  const gameId = randomGameId();
  const [gamePda, gameBump] = await deriveGamePda(gameId);
  const [vaultPda, vaultBump] = await deriveVaultPda(gamePda);
  info(`game PDA:   ${gamePda}`);

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
  ok(`Game initialized — tx: ${initSig}`);

  // --- Step 3: init_bounty_board ---
  step(3, "init_bounty_board — create the BountyBoard PDA");
  const [bountyPda, bountyBump] = await deriveBountyPda(gamePda);
  info(`bounty PDA: ${bountyPda}`);

  const initBbIx = getInitBountyBoardInstruction(
    {
      payer: wallet.address,
      gameSession: gamePda,
      bountyBoard: bountyPda,
    },
    { bump: bountyBump },
  );
  const initBbSig = await sendTx(ctx, wallet, [initBbIx]);
  ok(`BountyBoard created — tx: ${initBbSig}`);

  // Verify initial state
  const bb0 = await readBountyBoard(rpc, bountyPda);
  if (bb0.bountyCount !== 0) fail(`Expected bountyCount=0, got ${bb0.bountyCount}`);
  if (bb0.gameSession !== gamePda) {
    fail(`bounty.gameSession mismatch: expected ${gamePda}, got ${bb0.gameSession}`);
  }
  ok(`bountyCount=0, gameSession links to game PDA`);

  // --- Step 4: Add SURVIVOR bounty ---
  step(4, "add_bounty — SURVIVOR (claimable by anyone who stays)");
  const addSurvivorIx = getAddBountyInstruction(
    {
      authority: wallet.address,
      gameSession: gamePda,
      bountyBoard: bountyPda,
    },
    { bountyType: SURVIVOR, rewardAmount: 1000n },
  );
  const addSurvivorSig = await sendTx(ctx, wallet, [addSurvivorIx]);
  ok(`SURVIVOR bounty added — tx: ${addSurvivorSig}`);

  // --- Step 5: Add HIGH_SCORE bounty ---
  step(5, "add_bounty — HIGH_SCORE (threshold = 100000, intentionally unreachable)");
  const addHighScoreIx = getAddBountyInstruction(
    {
      authority: wallet.address,
      gameSession: gamePda,
      bountyBoard: bountyPda,
    },
    { bountyType: HIGH_SCORE, rewardAmount: 100_000n },
  );
  const addHighScoreSig = await sendTx(ctx, wallet, [addHighScoreIx]);
  ok(`HIGH_SCORE bounty added — tx: ${addHighScoreSig}`);

  // Verify both bounties are present and active
  const bb1 = await readBountyBoard(rpc, bountyPda);
  if (bb1.bountyCount !== 2) fail(`Expected bountyCount=2, got ${bb1.bountyCount}`);
  if (bb1.bounties[0].bountyType !== SURVIVOR) fail(`bounty[0].type wrong`);
  if (bb1.bounties[1].bountyType !== HIGH_SCORE) fail(`bounty[1].type wrong`);
  if (!bb1.bounties[0].isActive) fail(`bounty[0] should be active`);
  if (!bb1.bounties[1].isActive) fail(`bounty[1] should be active`);
  ok(`Both bounties present and active`);

  // --- Step 6: Set up the game (join, commit, start) ---
  step(6, "Set up the game so we can stay and claim SURVIVOR");
  const [psA, bumpA] = await derivePlayerPda(gameId, playerA.address);
  const [psB, bumpB] = await derivePlayerPda(gameId, playerB.address);

  const joinAIx = getJoinRoundInstruction(
    {
      gameSession: gamePda,
      playerState: psA,
      player: playerA.address,
      playerTokenAccount: playerA.address, // placeholder
      vault: vaultPda,
    },
    { bump: bumpA, stakeAmount: 100_000_000_000n },
  );
  const joinASig = await sendTx(ctx, playerA, [joinAIx], [playerA]);
  ok(`Player A joined — tx: ${joinASig}`);

  const joinBIx = getJoinRoundInstruction(
    {
      gameSession: gamePda,
      playerState: psB,
      player: playerB.address,
      playerTokenAccount: playerB.address,
      vault: vaultPda,
    },
    { bump: bumpB, stakeAmount: 100_000_000_000n },
  );
  const joinBSig = await sendTx(ctx, playerB, [joinBIx], [playerB]);
  ok(`Player B joined — tx: ${joinBSig}`);

  console.log(`  ${c.dim}(dealer proof generation, ~30s)${c.reset}`);
  const dealer = new Dealer(DEALER_CONFIG);
  const t0 = Date.now();
  await dealer.shuffle();
  ok(`Proof generated in ${Date.now() - t0}ms`);

  const proof = dealer.getSerializedProof();
  const merkleRoot = dealer.getMerkleRoot();
  const commitIx = getCommitDeckInstruction(
    { gameSession: gamePda, dealer: dealerSigner.address },
    { merkleRoot, proofA: proof.proofA, proofB: proof.proofB, proofC: proof.proofC },
  );
  const commitCuIx = getSetComputeUnitLimitInstruction({ units: COMMIT_DECK_COMPUTE_LIMIT });
  const commitSig = await sendTx(ctx, dealerSigner, [commitCuIx, commitIx], [dealerSigner]);
  ok(`Deck committed — tx: ${commitSig}`);

  const startIx = getStartRoundInstruction({
    gameSession: gamePda,
    authority: wallet.address,
    playerStates: [psA, psB],
  });
  const startSig = await sendTx(ctx, wallet, [startIx]);
  ok(`Round started — tx: ${startSig}`);

  // --- Step 7: Player A draws and stays ---
  step(7, "Player A: hit + stay → eligible for SURVIVOR bounty");
  const revealA = dealer.revealNextCard();
  const hitAIx = getHitInstruction(
    { gameSession: gamePda, playerState: psA, player: playerA.address },
    {
      cardValue: revealA.card.value,
      cardType: revealA.card.cardType,
      cardSuit: revealA.card.suit,
      merkleProof: revealA.proof,
      leafIndex: revealA.leafIndex,
    },
  );
  const hitCuIx = getSetComputeUnitLimitInstruction({ units: HIT_COMPUTE_LIMIT });
  const hitASig = await sendTx(ctx, playerA, [hitCuIx, hitAIx], [playerA]);
  ok(`Player A hit — tx: ${hitASig}`);

  const stayAIx = getStayInstruction({
    gameSession: gamePda,
    playerState: psA,
    player: playerA.address,
  });
  const stayASig = await sendTx(ctx, playerA, [stayAIx], [playerA]);
  ok(`Player A stayed — tx: ${stayASig}`);

  // --- Step 8: NEGATIVE TEST — claim_bounty mid-round must be REJECTED ---
  // Heavy-duty review #5 fix M1: claim_bounty refuses to fire while
  // round_active is true. This prevents a first-stayer from sniping a
  // SURVIVOR bounty before other players have a chance to act.
  step(8, "Player A tries to claim mid-round — NEGATIVE TEST (round_active gate)");
  info(`The round is still active (player B hasn't acted yet).`);
  info(`The on-chain round_active check should reject this claim with error #3 (RoundAlreadyActive).`);

  const claimMidRoundIx = getClaimBountyInstruction(
    {
      player: playerA.address,
      gameSession: gamePda,
      playerState: psA,
      bountyBoard: bountyPda,
    },
    { bountyIndex: 0 },
  );

  let midRoundRejected = false;
  try {
    await sendTx(ctx, playerA, [claimMidRoundIx], [playerA]);
  } catch (err) {
    midRoundRejected = true;
    const msg = err instanceof Error ? err.message : String(err);
    info(`(expected rejection: ${msg.split("\n")[0]})`);
  }
  if (!midRoundRejected) {
    fail(`Mid-round claim should have been rejected by M1 gate, but succeeded!`);
  }
  ok(`Mid-round claim correctly rejected (round_active gate fired)`);

  // --- Step 9: Player B draws + stays so both players are inactive ---
  step(9, "Player B: hit + stay (so end_round can finalize)");
  const revealB = dealer.revealNextCard();
  const hitBIx = getHitInstruction(
    { gameSession: gamePda, playerState: psB, player: playerB.address },
    {
      cardValue: revealB.card.value,
      cardType: revealB.card.cardType,
      cardSuit: revealB.card.suit,
      merkleProof: revealB.proof,
      leafIndex: revealB.leafIndex,
    },
  );
  const hitBSig = await sendTx(ctx, playerB, [hitCuIx, hitBIx], [playerB]);
  ok(`Player B hit — tx: ${hitBSig}`);

  const stayBIx = getStayInstruction({
    gameSession: gamePda,
    playerState: psB,
    player: playerB.address,
  });
  const stayBSig = await sendTx(ctx, playerB, [stayBIx], [playerB]);
  ok(`Player B stayed — tx: ${stayBSig}`);

  // --- Step 10: end_round so claims are now allowed ---
  step(10, "Authority calls end_round so claims unlock");
  const endRoundIx = getEndRoundInstruction({
    gameSession: gamePda,
    caller: wallet.address,
    vault: vaultPda,
    winnerTokenAccount: wallet.address, // placeholder, vault_ready=false
    treasuryTokenAccount: wallet.address,
    playerStates: [psA, psB],
  });
  const endRoundSig = await sendTx(ctx, wallet, [endRoundIx]);
  ok(`Round ended — tx: ${endRoundSig}`);

  // --- Step 11: Player A claims SURVIVOR bounty (POSITIVE TEST) ---
  step(11, "Player A claims bounty 0 (SURVIVOR) — POSITIVE TEST");
  const claimSurvivorIx = getClaimBountyInstruction(
    {
      player: playerA.address,
      gameSession: gamePda,
      playerState: psA,
      bountyBoard: bountyPda,
    },
    { bountyIndex: 0 },
  );
  const claimSurvivorSig = await sendTx(ctx, playerA, [claimSurvivorIx], [playerA]);
  ok(`SURVIVOR claim succeeded — tx: ${claimSurvivorSig}`);

  // Verify bounty 0 is now claimed by playerA. claimedBy is stored as raw
  // 32 bytes, so we encode playerA.address into bytes for comparison.
  const bb2 = await readBountyBoard(rpc, bountyPda);
  if (bb2.bounties[0].isActive) fail(`bounty[0] should be inactive after claim`);
  const playerABytes = getAddressEncoder().encode(playerA.address);
  const claimedByBytes = bb2.bounties[0].claimedBy;
  if (claimedByBytes.length !== playerABytes.length) {
    fail(`claimedBy length wrong: ${claimedByBytes.length} vs ${playerABytes.length}`);
  }
  for (let i = 0; i < 32; i++) {
    if (claimedByBytes[i] !== playerABytes[i]) {
      fail(`bounty[0].claimedBy bytes mismatch at index ${i}`);
    }
  }
  if (!bb2.bounties[1].isActive) {
    fail(`bounty[1] should still be active (only bounty[0] was claimed)`);
  }
  ok(`bounty[0] now inactive, claimed_by = playerA`);
  ok(`bounty[1] still active and unclaimed`);

  // --- Step 12: NEGATIVE TEST — try to claim HIGH_SCORE that wasn't met ---
  step(12, "Player B tries to claim bounty 1 (HIGH_SCORE) — NEGATIVE TEST");
  info(`Threshold is 100000; player B's score from one card is way less.`);
  info(`The on-chain win-condition check should reject this claim.`);

  const claimHighScoreIx = getClaimBountyInstruction(
    {
      player: playerB.address,
      gameSession: gamePda,
      playerState: psB,
      bountyBoard: bountyPda,
    },
    { bountyIndex: 1 },
  );

  let rejected = false;
  try {
    await sendTx(ctx, playerB, [claimHighScoreIx], [playerB]);
  } catch (err) {
    rejected = true;
    const msg = err instanceof Error ? err.message : String(err);
    info(`(expected rejection: ${msg.split("\n")[0]})`);
  }
  if (!rejected) {
    fail(`HIGH_SCORE claim should have been rejected, but succeeded!`);
  }
  ok(`HIGH_SCORE claim correctly rejected (win condition not met)`);

  // Verify bounty 1 is still active
  const bb3 = await readBountyBoard(rpc, bountyPda);
  if (!bb3.bounties[1].isActive) fail(`bounty[1] should still be active after rejected claim`);
  ok(`bounty[1] still active and unclaimed (state unchanged)`);

  // --- Step 13: leave_game ×2 ---
  step(13, "leave_game ×2");

  const leaveBIx = getLeaveGameInstruction({
    gameSession: gamePda,
    playerState: psB,
    player: playerB.address,
    recipient: playerB.address,
  });
  await sendTx(ctx, playerB, [leaveBIx], [playerB]);
  ok(`Player B left`);

  const leaveAIx = getLeaveGameInstruction({
    gameSession: gamePda,
    playerState: psA,
    player: playerA.address,
    recipient: playerA.address,
  });
  await sendTx(ctx, playerA, [leaveAIx], [playerA]);
  ok(`Player A left`);

  // --- Step 12: close_bounty_board ---
  step(14, "close_bounty_board — refund rent");
  const closeBbIx = getCloseBountyBoardInstruction({
    bountyBoard: bountyPda,
    authority: wallet.address,
    gameSession: gamePda,
    recipient: wallet.address,
  });
  const closeBbSig = await sendTx(ctx, wallet, [closeBbIx]);
  ok(`BountyBoard closed — tx: ${closeBbSig}`);

  // Verify bounty board PDA is gone
  const bbAfterClose = await retry("getAccountInfo(bountyPda) post-close", () =>
    rpc.getAccountInfo(bountyPda, { encoding: "base64" }).send(),
  );
  if (bbAfterClose.value !== null) fail(`BountyBoard should be closed`);
  ok(`BountyBoard PDA closed`);

  // --- Step 13: close_game ---
  step(15, "close_game");
  const closeGameIx = getCloseGameInstruction({
    gameSession: gamePda,
    authority: wallet.address,
    recipient: wallet.address,
  });
  const closeGameSig = await sendTx(ctx, wallet, [closeGameIx]);
  ok(`Game closed — tx: ${closeGameSig}`);

  // --- Final summary ---
  console.log(`\n${c.bold}${c.green}╔════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}${c.green}║  ✓ BOUNTY SMOKE TEST PASSED                        ║${c.reset}`);
  console.log(`${c.bold}${c.green}╚════════════════════════════════════════════════════╝${c.reset}`);
  console.log(`\n${c.bold}Verified empirically on devnet:${c.reset}`);
  console.log(`  ${c.green}✓${c.reset} ${c.bold}init_bounty_board${c.reset} creates BountyBoard PDA via PDA-signed CPI`);
  console.log(`  ${c.green}✓${c.reset} ${c.bold}add_bounty${c.reset} appends bounties (×2: SURVIVOR + HIGH_SCORE)`);
  console.log(`  ${c.green}✓${c.reset} ${c.bold}claim_bounty${c.reset} (POSITIVE) marks bounty as claimed when win condition met`);
  console.log(`  ${c.green}✓${c.reset} ${c.bold}claim_bounty${c.reset} (NEGATIVE) rejects claims when win condition NOT met`);
  console.log(`  ${c.green}✓${c.reset} ${c.bold}close_bounty_board${c.reset} refunds rent and closes the PDA`);
  console.log(`\n${c.dim}game_id:    ${gameId}${c.reset}`);
  console.log(`${c.dim}bounty PDA: ${bountyPda} (closed)${c.reset}\n`);
}

main()
  .then(() => process.exit(0)) // force-exit so an open WSS handle doesn't keep us alive
  .catch((e) => {
    console.error(`\n${c.red}${c.bold}Bounty smoke test crashed:${c.reset}`);
    console.error(e);
    process.exit(1);
  });
