/**
 * Poseidon Merkle tree — must produce identical hashes to the on-chain
 * light_poseidon (circom-compatible BN254 params) and the Circom circuit.
 */

import { buildPoseidon } from "circomlibjs";
import { type Card, DECK_SIZE, NUM_LEAVES, TREE_DEPTH } from "./deck.js";

// Lazy-initialized Poseidon instance
let poseidon: Awaited<ReturnType<typeof buildPoseidon>> | null = null;

export async function getPoseidon() {
  if (!poseidon) {
    poseidon = await buildPoseidon();
  }
  return poseidon;
}

export interface MerkleTree {
  /** All levels of the tree, from leaves (index 0) to root (last). */
  levels: bigint[][];
  /** The Merkle root. */
  root: bigint;
  /** The leaf hashes (level 0). */
  leaves: bigint[];
}

/**
 * Hash a card into a leaf: Poseidon(value, cardType, suit, leafIndex).
 * Returns a BN254 field element as bigint.
 */
export async function hashCardLeaf(
  value: number,
  cardType: number,
  suit: number,
  leafIndex: number,
): Promise<bigint> {
  const p = await getPoseidon();
  const h = p([value, cardType, suit, leafIndex]);
  return p.F.toObject(h);
}

/**
 * Build a complete Poseidon Merkle tree from a shuffled deck.
 *
 * Leaves 0..93: Poseidon(card.value, card.cardType, card.suit, leafIndex)
 * Leaves 94..127: Poseidon(0, 0, 0, leafIndex) — padding
 */
export async function buildMerkleTree(shuffledDeck: Card[]): Promise<MerkleTree> {
  if (shuffledDeck.length !== DECK_SIZE) {
    throw new Error(`Expected ${DECK_SIZE} cards, got ${shuffledDeck.length}`);
  }

  const p = await getPoseidon();
  const F = p.F;

  // Compute leaf hashes
  const leaves: bigint[] = [];

  // Real card leaves
  for (let i = 0; i < DECK_SIZE; i++) {
    const card = shuffledDeck[i];
    const h = p([card.value, card.cardType, card.suit, i]);
    leaves.push(F.toObject(h));
  }

  // Padding leaves
  for (let i = DECK_SIZE; i < NUM_LEAVES; i++) {
    const h = p([0, 0, 0, i]);
    leaves.push(F.toObject(h));
  }

  // Build tree bottom-up
  const levels: bigint[][] = [leaves];
  let currentLevel = leaves;

  for (let depth = 0; depth < TREE_DEPTH; depth++) {
    const nextLevel: bigint[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const h = p([
        F.e(currentLevel[i]),
        F.e(currentLevel[i + 1]),
      ]);
      nextLevel.push(F.toObject(h));
    }
    levels.push(nextLevel);
    currentLevel = nextLevel;
  }

  return {
    levels,
    root: currentLevel[0],
    leaves,
  };
}

/**
 * Extract a Merkle proof (sibling hashes) for a given leaf index.
 * Returns TREE_DEPTH sibling hashes, from leaf level to root.
 */
export function getMerkleProof(tree: MerkleTree, leafIndex: number): bigint[] {
  if (leafIndex < 0 || leafIndex >= NUM_LEAVES) {
    throw new Error(`Leaf index out of range: ${leafIndex}`);
  }

  const proof: bigint[] = [];
  let idx = leafIndex;

  for (let level = 0; level < TREE_DEPTH; level++) {
    const siblingIdx = idx ^ 1;
    proof.push(tree.levels[level][siblingIdx]);
    idx >>= 1;
  }

  return proof;
}

/**
 * Compute the canonical deck hash — chain of Poseidon hashes matching
 * the Circom CanonicalDeckHash template.
 */
export async function computeCanonicalHash(deck: Card[]): Promise<bigint> {
  const p = await getPoseidon();
  const F = p.F;

  // Hash each card: Poseidon(value, type, suit, index)
  const cardHashes = deck.map((card, i) =>
    p([card.value, card.cardType, card.suit, i])
  );

  // Chain hash: Poseidon(prev, next)
  let running = cardHashes[0];
  for (let i = 1; i < deck.length; i++) {
    running = p([running, cardHashes[i]]);
  }

  return F.toObject(running);
}

/**
 * Convert a BN254 field element (bigint) to a 32-byte big-endian Uint8Array.
 * This matches the on-chain format used by light_poseidon.
 */
export function bigintToBytes32BE(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(64, "0");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Convert a 32-byte big-endian Uint8Array to a bigint.
 */
export function bytes32BEToBigint(bytes: Uint8Array): bigint {
  let hex = "0x";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return BigInt(hex);
}
