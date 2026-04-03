/**
 * ZK Dealer Service — manages deck shuffling, commitment, and card reveals.
 *
 * The dealer:
 * 1. Shuffles the canonical deck using Fisher-Yates with crypto-quality RNG
 * 2. Builds a Poseidon Merkle tree over the shuffled deck
 * 3. Generates a Groth16 proof that the shuffle is a valid permutation
 * 4. Submits the Merkle root + proof on-chain via commit_deck
 * 5. Reveals cards sequentially with Merkle proofs
 */

import {
  type Card,
  createCanonicalDeck,
  fisherYatesShuffle,
  applyPermutation,
  DECK_SIZE,
} from "./deck.js";
import {
  type MerkleTree,
  buildMerkleTree,
  getMerkleProof,
  bigintToBytes32BE,
} from "./merkle.js";
import {
  generateProof,
  verifyProofLocally,
  packCommitDeckData,
  type SerializedProof,
} from "./prover.js";

export interface CardReveal {
  /** The revealed card */
  card: Card;
  /** Leaf index in the Merkle tree */
  leafIndex: number;
  /** Merkle proof (TREE_DEPTH sibling hashes, as 32-byte BE arrays) */
  proof: Uint8Array[];
}

export interface DealerConfig {
  /** Path to the WASM witness generator */
  wasmPath: string;
  /** Path to the proving key (.zkey) */
  zkeyPath: string;
  /** Path to the verification key (for local verification) */
  vkeyPath: string;
}

export class Dealer {
  private config: DealerConfig;
  private canonicalDeck: Card[];

  // Current round state
  private permutation: number[] | null = null;
  private shuffledDeck: Card[] | null = null;
  private merkleTree: MerkleTree | null = null;
  private serializedProof: SerializedProof | null = null;
  private nextLeafIndex: number = 0;

  constructor(config: DealerConfig) {
    this.config = config;
    this.canonicalDeck = createCanonicalDeck();
  }

  /**
   * Shuffle the deck and generate a Groth16 proof.
   * Call this at the start of each round.
   *
   * @returns The packed commit_deck instruction data (288 bytes)
   */
  async shuffle(): Promise<Uint8Array> {
    // Reset state
    this.nextLeafIndex = 0;

    // Fisher-Yates with crypto randomness
    this.permutation = fisherYatesShuffle();
    this.shuffledDeck = applyPermutation(this.canonicalDeck, this.permutation);

    // Build Merkle tree
    this.merkleTree = await buildMerkleTree(this.shuffledDeck);

    // Generate Groth16 proof
    const result = await generateProof(
      this.permutation,
      this.canonicalDeck,
      this.shuffledDeck,
      this.config.wasmPath,
      this.config.zkeyPath,
    );

    // Verify locally before committing
    const valid = await verifyProofLocally(
      result.rawProof,
      result.publicSignals,
      this.config.vkeyPath,
    );
    if (!valid) {
      throw new Error("Local proof verification failed — aborting commit");
    }

    this.serializedProof = result.serialized;

    // Pack into commit_deck instruction data
    return packCommitDeckData(result.serialized);
  }

  /**
   * Get the Merkle root for the current round (32 bytes, big-endian).
   */
  getMerkleRoot(): Uint8Array {
    if (!this.merkleTree) {
      throw new Error("No deck committed — call shuffle() first");
    }
    return bigintToBytes32BE(this.merkleTree.root);
  }

  /**
   * Reveal the next card in sequence.
   *
   * Enforces sequential access — cards must be revealed in order.
   * This matches the on-chain draw_counter that tracks which card is next.
   */
  revealNextCard(): CardReveal {
    if (!this.shuffledDeck || !this.merkleTree) {
      throw new Error("No deck committed — call shuffle() first");
    }
    if (this.nextLeafIndex >= DECK_SIZE) {
      throw new Error("All cards have been revealed");
    }

    const leafIndex = this.nextLeafIndex;
    const card = this.shuffledDeck[leafIndex];

    // Get Merkle proof (bigints → 32-byte BE arrays)
    const proofBigints = getMerkleProof(this.merkleTree, leafIndex);
    const proof = proofBigints.map((bi) => bigintToBytes32BE(bi));

    this.nextLeafIndex++;

    return { card, leafIndex, proof };
  }

  /**
   * Reveal a specific card by index. Rejects out-of-order requests.
   *
   * @param index - Must match nextLeafIndex exactly
   */
  revealCard(index: number): CardReveal {
    if (index !== this.nextLeafIndex) {
      throw new Error(
        `Out-of-order reveal: expected index ${this.nextLeafIndex}, got ${index}`,
      );
    }
    return this.revealNextCard();
  }

  /**
   * Get the current draw counter (next card index to be revealed).
   */
  getNextLeafIndex(): number {
    return this.nextLeafIndex;
  }

  /**
   * Check if a round is active (deck has been committed).
   */
  isRoundActive(): boolean {
    return this.merkleTree !== null;
  }

  /**
   * Reset the dealer state for a new round.
   */
  reset(): void {
    this.permutation = null;
    this.shuffledDeck = null;
    this.merkleTree = null;
    this.serializedProof = null;
    this.nextLeafIndex = 0;
  }
}
