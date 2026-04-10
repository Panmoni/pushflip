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
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  appendTransactionMessageInstruction,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  devnet,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  lamports,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
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
  getHitInstruction,
  getInitializeInstruction,
  getJoinRoundInstruction,
  getStartRoundInstruction,
  PUSHFLIP_PROGRAM_ID,
} from "@pushflip/client";
import { Dealer } from "@pushflip/dealer";

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// --- Config ---

const DEVNET_RPC_URL = "https://api.devnet.solana.com";
const DEVNET_WS_URL = "wss://api.devnet.solana.com";
const REPO_ROOT = resolve(import.meta.dirname, "..");
const ZK_BUILD_DIR = resolve(REPO_ROOT, "zk-circuits/build");
const DEALER_CONFIG = {
  wasmPath: resolve(ZK_BUILD_DIR, "shuffle_verify_js/shuffle_verify.wasm"),
  zkeyPath: resolve(ZK_BUILD_DIR, "shuffle_verify_final.zkey"),
  vkeyPath: resolve(ZK_BUILD_DIR, "verification_key.json"),
};

// Lamports each ephemeral player needs:
//   - PlayerState rent: ~0.0019 SOL (256-byte account)
//   - A few tx fees (5000 lamports each)
//   - Buffer
const PLAYER_FUNDING_LAMPORTS = 5_000_000n; // 0.005 SOL per player

// Compute budget for instructions that touch Poseidon. The default 200K is
// known to be tight for both commit_deck (Groth16 verification) and hit
// (Poseidon Merkle verification).
const HIT_COMPUTE_LIMIT = 400_000;
const COMMIT_DECK_COMPUTE_LIMIT = 400_000;

// --- Helpers ---

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

function step(n: number, label: string): void {
  console.log(`\n${c.bold}${c.cyan}[${n}]${c.reset} ${c.bold}${label}${c.reset}`);
}

function ok(msg: string): void {
  console.log(`  ${c.green}✓${c.reset} ${msg}`);
}

function info(msg: string): void {
  console.log(`  ${c.dim}${msg}${c.reset}`);
}

function fail(msg: string): never {
  console.log(`  ${c.red}✗${c.reset} ${msg}`);
  process.exit(1);
}

/** Random u64 game_id derived from current time + random bytes. */
function randomGameId(): bigint {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let val = 0n;
  for (const b of bytes) val = (val << 8n) | BigInt(b);
  return val;
}

/** Load the Solana CLI default keypair as a signer. */
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

/** Build, sign, send, and confirm a transaction. Returns the signature. */
async function sendTx(
  ctx: RpcContext,
  feePayer: KeyPairSigner,
  instructions: Parameters<typeof appendTransactionMessageInstructions>[0],
  // Extra signers are listed for documentation, but Kit's
  // `signTransactionMessageWithSigners` walks the message's accounts list
  // and resolves each `KeyPairSigner` automatically — there's no separate
  // signers argument to pass through.
  _signers: KeyPairSigner[] = [],
): Promise<string> {
  const { value: blockhash } = await ctx.rpc.getLatestBlockhash().send();

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );

  const signed = await signTransactionMessageWithSigners(message);
  await ctx.sendAndConfirm(signed, { commitment: "confirmed" });
  return getSignatureFromTransaction(signed);
}

// --- Main ---

async function main(): Promise<void> {
  console.log(`${c.bold}${c.blue}╔════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}${c.blue}║  PushFlip Devnet Smoke Test (Task 3.0)             ║${c.reset}`);
  console.log(`${c.bold}${c.blue}╚════════════════════════════════════════════════════╝${c.reset}`);
  console.log(`${c.dim}Program: ${PUSHFLIP_PROGRAM_ID}${c.reset}`);
  console.log(`${c.dim}Cluster: devnet${c.reset}`);

  const rpc = createSolanaRpc(devnet(DEVNET_RPC_URL));
  const rpcSubs = createSolanaRpcSubscriptions(devnet(DEVNET_WS_URL));
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: rpcSubs });
  const ctx: RpcContext = { rpc, rpcSubs, sendAndConfirm };

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

  // --- Step 8: Cleanup — close the game to recover rent ---
  step(8, "Close game (recover rent)");
  // The game can only be closed when no round is active. We're mid-round,
  // so we can't close cleanly without ending the round first. End_round
  // requires all players inactive (busted or stayed). For the smoke test,
  // we just leave the round active and let the rent stay parked. The wallet
  // can recover it later by ending the round + closing the game manually.
  info(
    `(skipping close — round is active and ending it requires player B to also act)`,
  );
  info(
    `Game and player state PDAs left intact for forensic inspection.`,
  );

  // --- Final summary ---
  console.log(`\n${c.bold}${c.green}╔════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}${c.green}║  ✓ SMOKE TEST PASSED                               ║${c.reset}`);
  console.log(`${c.bold}${c.green}╚════════════════════════════════════════════════════╝${c.reset}`);
  console.log(`\n${c.bold}Verified empirically on devnet:${c.reset}`);
  console.log(`  ${c.green}✓${c.reset} Initialize → join (×2) → commit_deck → start_round → hit pipeline works`);
  console.log(`  ${c.green}✓${c.reset} Groth16 proof verification on real alt_bn128 syscalls works`);
  console.log(`  ${c.green}✓${c.reset} ${c.bold}sol_poseidon syscall + Merkle proof verification work on the real validator${c.reset}`);
  console.log(`  ${c.green}✓${c.reset} Card data round-trip: dealer → on-chain → client deserialize`);
  console.log(`  ${c.green}✓${c.reset} The initialize design fix (no auto-add House) holds on real validator`);
  console.log(`\n${c.dim}Game PDA (left active for inspection): ${gamePda}${c.reset}`);
  console.log(`${c.dim}game_id: ${gameId}${c.reset}`);
  console.log(`\n${c.dim}Next: Phase 3.1 — frontend scaffolding${c.reset}\n`);
}

main().catch((e) => {
  console.error(`\n${c.red}${c.bold}Smoke test crashed:${c.reset}`);
  console.error(e);
  process.exit(1);
});
