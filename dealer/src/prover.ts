/**
 * Groth16 proof generation and serialization for Solana on-chain verification.
 *
 * Handles the critical endianness conversion between snarkjs output
 * and what pinocchio-groth16 / Solana alt_bn128 syscalls expect.
 */

import * as snarkjs from "snarkjs";
import { type Card, DECK_SIZE, NUM_LEAVES } from "./deck.js";
import {
  buildMerkleTree,
  computeCanonicalHash,
  bigintToBytes32BE,
  getPoseidon,
} from "./merkle.js";

// BN254 base field prime (Fq) — used for G1 point negation
const BN254_FIELD_PRIME =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

export interface SerializedProof {
  /** G1 point, negated, 64 bytes big-endian */
  proofA: Uint8Array;
  /** G2 point, 128 bytes big-endian */
  proofB: Uint8Array;
  /** G1 point, 64 bytes big-endian */
  proofC: Uint8Array;
  /** [merkleRoot, canonicalHash] as 32-byte BE field elements */
  publicInputs: [Uint8Array, Uint8Array];
}

/**
 * Convert a decimal string to a 32-byte big-endian Uint8Array.
 */
function decimalTo32BytesBE(decimal: string): Uint8Array {
  return bigintToBytes32BE(BigInt(decimal));
}

/**
 * Negate a G1 point's Y coordinate: y → p - y (mod BN254 Fq).
 * This is required because pinocchio-groth16 expects proof_a to be negated.
 */
function negateG1(g1Bytes: Uint8Array): Uint8Array {
  const x = g1Bytes.slice(0, 32);
  const yBytes = g1Bytes.slice(32, 64);

  // Convert y from big-endian bytes to bigint
  let y = 0n;
  for (const b of yBytes) {
    y = (y << 8n) | BigInt(b);
  }

  // Negate: p - y
  const negY = BN254_FIELD_PRIME - y;

  const result = new Uint8Array(64);
  result.set(x, 0);
  result.set(bigintToBytes32BE(negY), 32);
  return result;
}

/**
 * Serialize a snarkjs G1 proof element to 64 bytes big-endian.
 * snarkjs pi_a/pi_c = [x, y, "1"] as decimal strings.
 */
function serializeG1(point: string[]): Uint8Array {
  const result = new Uint8Array(64);
  result.set(decimalTo32BytesBE(point[0]), 0);
  result.set(decimalTo32BytesBE(point[1]), 32);
  return result;
}

/**
 * Serialize a snarkjs G2 proof element to 128 bytes big-endian.
 * snarkjs pi_b = [[x_imag, x_real], [y_imag, y_real], ["1","0"]]
 * Solana alt_bn128 expects: x_imag || x_real || y_imag || y_real
 */
function serializeG2(point: string[][]): Uint8Array {
  const result = new Uint8Array(128);
  result.set(decimalTo32BytesBE(point[0][0]), 0);   // x_imag
  result.set(decimalTo32BytesBE(point[0][1]), 32);  // x_real
  result.set(decimalTo32BytesBE(point[1][0]), 64);  // y_imag
  result.set(decimalTo32BytesBE(point[1][1]), 96);  // y_real
  return result;
}

export interface ProofGenerationResult {
  /** Serialized proof ready for on-chain submission */
  serialized: SerializedProof;
  /** Raw snarkjs proof (for local verification) */
  rawProof: snarkjs.Groth16Proof;
  /** Public signals as decimal strings */
  publicSignals: string[];
}

/**
 * Generate a Groth16 proof that a shuffled deck is a valid permutation
 * of the canonical deck.
 *
 * @param permutation - The shuffle permutation (perm[i] = canonical index at shuffled position i)
 * @param canonicalDeck - The canonical deck
 * @param shuffledDeck - The shuffled deck (for Merkle tree computation)
 * @param wasmPath - Path to the circuit's WASM witness generator
 * @param zkeyPath - Path to the circuit's proving key
 */
export async function generateProof(
  permutation: number[],
  canonicalDeck: Card[],
  shuffledDeck: Card[],
  wasmPath: string,
  zkeyPath: string,
): Promise<ProofGenerationResult> {
  // Build Merkle tree to compute root
  const tree = await buildMerkleTree(shuffledDeck);
  const merkleRoot = tree.root;

  // Compute canonical deck hash
  const canonicalHash = await computeCanonicalHash(canonicalDeck);

  // Prepare circuit inputs
  const input = {
    merkle_root: merkleRoot.toString(),
    canonical_hash: canonicalHash.toString(),
    permutation: permutation.map(String),
    canonical_values: canonicalDeck.map((c) => String(c.value)),
    canonical_types: canonicalDeck.map((c) => String(c.cardType)),
    canonical_suits: canonicalDeck.map((c) => String(c.suit)),
  };

  // Generate proof
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    wasmPath,
    zkeyPath,
  );

  // Serialize for on-chain verification
  const proofA = negateG1(serializeG1(proof.pi_a));
  const proofB = serializeG2(proof.pi_b);
  const proofC = serializeG1(proof.pi_c);

  const serialized: SerializedProof = {
    proofA,
    proofB,
    proofC,
    publicInputs: [
      bigintToBytes32BE(merkleRoot),
      bigintToBytes32BE(canonicalHash),
    ],
  };

  return { serialized, rawProof: proof, publicSignals };
}

/**
 * Verify a proof locally using snarkjs before submitting on-chain.
 */
export async function verifyProofLocally(
  proof: snarkjs.Groth16Proof,
  publicSignals: string[],
  vkeyPath: string,
): Promise<boolean> {
  const { readFileSync } = await import("fs");
  const vkey = JSON.parse(readFileSync(vkeyPath, "utf-8"));
  return snarkjs.groth16.verify(vkey, publicSignals, proof);
}

/**
 * Pack proof bytes into the commit_deck instruction data format:
 * [0..32]   merkle_root
 * [32..96]  proof_a (64 bytes)
 * [96..224] proof_b (128 bytes)
 * [224..288] proof_c (64 bytes)
 */
export function packCommitDeckData(serialized: SerializedProof): Uint8Array {
  const data = new Uint8Array(288);
  data.set(serialized.publicInputs[0], 0);   // merkle_root
  data.set(serialized.proofA, 32);            // proof_a
  data.set(serialized.proofB, 96);            // proof_b
  data.set(serialized.proofC, 224);           // proof_c
  return data;
}
