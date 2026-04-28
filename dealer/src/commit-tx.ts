/**
 * Helper that builds + submits the `commit_deck` transaction for a
 * dealer round. Extracted from the inline pattern in
 * `scripts/smoke-test.ts:250-263` so the production dealer service
 * (`service.ts`) and the smoke test can share one implementation
 * once smoke-test is migrated.
 *
 * **Why an explicit module rather than a closure inside service.ts**:
 * the on-chain compute-budget constant (`COMMIT_DECK_COMPUTE_LIMIT`)
 * and the instruction-shape glue (`getCommitDeckInstruction` +
 * `getSetComputeUnitLimitInstruction`) are exactly the bits that
 * must stay in lockstep with `program/src/instructions/commit_deck.rs`.
 * Co-locating them in one helper makes a future on-chain CU bump or
 * accounts-list change a one-edit change instead of N parallel edits
 * across consumers.
 *
 * **Pre-Mainnet 5.2 / Phase 4 scope**: this is the dealer-side write
 * path. Read paths (reveal serving) are inside the `Dealer` class
 * itself (`revealCard`).
 */

import {
  deriveGamePda,
  getCommitDeckInstruction,
} from "@pushflip/client";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import {
  type Address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createTransactionMessage,
  getSignatureFromTransaction,
  type KeyPairSigner,
  pipe,
  type Rpc,
  type SolanaRpcApi,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";

import type { Dealer } from "./dealer.js";

/**
 * Compute-unit limit for `commit_deck`. The on-chain Groth16
 * verification empirically consumes ~86K CU; the 200K bump leaves
 * ~55% headroom for any future per-instruction overhead. Same value
 * the smoke-test uses (`scripts/smoke-test.ts:100`).
 *
 * If this is ever changed, also bump
 * `assertCuBudget(rpc, sig, "commit_deck", N)` in the smoke-test so
 * the regression guard tracks the new limit.
 */
export const COMMIT_DECK_COMPUTE_LIMIT = 400_000;

export interface CommitDeckResult {
  signature: string;
  /** PDA the commit_deck transaction targeted (cached for caller convenience). */
  gameSession: Address;
}

/**
 * Generate a fresh shuffle (via `dealer.shuffle()`), build the
 * corresponding `commit_deck` instruction with the bumped compute
 * limit, sign with the dealer's keypair, and submit + confirm.
 *
 * Caller must own the `Dealer` instance (state lives there). On
 * success, the dealer's internal Merkle tree + serialized proof
 * are populated and `revealCard` becomes callable.
 *
 * Throws if shuffle/proof-gen or send/confirm fails. Caller is
 * responsible for resetting the dealer (`dealer.reset()`) on failure
 * — this helper does NOT auto-reset because the right recovery
 * action depends on context (HTTP error vs. retry vs. operator
 * intervention).
 */
export async function commitDeckForGame(args: {
  dealer: Dealer;
  dealerSigner: KeyPairSigner;
  rpc: Rpc<SolanaRpcApi>;
  sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory>;
  gameId: bigint;
}): Promise<CommitDeckResult> {
  const { dealer, dealerSigner, rpc, sendAndConfirm, gameId } = args;

  // Generate the proof (this is the slow path — ~30s for the witness +
  // Groth16 prover). Throws if the local pre-flight verification
  // (verify_proof_locally inside dealer.shuffle()) fails, which means
  // we'd never have submitted a valid proof anyway.
  await dealer.shuffle();

  const proof = dealer.getSerializedProof();
  const merkleRoot = dealer.getMerkleRoot();
  const [gameSession] = await deriveGamePda(gameId);

  const commitIx = getCommitDeckInstruction(
    { gameSession, dealer: dealerSigner.address },
    {
      merkleRoot,
      proofA: proof.proofA,
      proofB: proof.proofB,
      proofC: proof.proofC,
    },
  );
  const commitCuIx = getSetComputeUnitLimitInstruction({
    units: COMMIT_DECK_COMPUTE_LIMIT,
  });

  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(dealerSigner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([commitCuIx, commitIx], m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(signed);
  await sendAndConfirm(signed, { commitment: "confirmed" });
  const signature = getSignatureFromTransaction(signed);

  return { signature, gameSession };
}
