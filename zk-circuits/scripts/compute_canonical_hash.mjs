#!/usr/bin/env node
/**
 * Compute the canonical deck hash and output it as a Rust [u8; 32] constant.
 * This hash is a public input to the Groth16 circuit.
 */
import { buildPoseidon } from "circomlibjs";

const DECK_SIZE = 94;

function createCanonicalDeck() {
  const values = [], types = [], suits = [];
  for (let suit = 0; suit < 4; suit++)
    for (let value = 1; value <= 13; value++) {
      values.push(value); types.push(0); suits.push(suit);
    }
  for (const effect of [0, 1, 2])
    for (let i = 0; i < 10; i++) {
      values.push(effect); types.push(1); suits.push(0);
    }
  for (const mult of [2, 3, 5])
    for (let i = 0; i < 4; i++) {
      values.push(mult); types.push(2); suits.push(0);
    }
  return { values, types, suits };
}

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const { values, types, suits } = createCanonicalDeck();

  const cardHashes = [];
  for (let i = 0; i < DECK_SIZE; i++) {
    cardHashes.push(poseidon([values[i], types[i], suits[i], i]));
  }

  let running = cardHashes[0];
  for (let i = 1; i < DECK_SIZE; i++) {
    running = poseidon([running, cardHashes[i]]);
  }

  const hashBigint = F.toObject(running);
  const hex = hashBigint.toString(16).padStart(64, "0");
  const bytes = [];
  for (let i = 0; i < 64; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }

  console.log(`Canonical deck hash (decimal): ${hashBigint}`);
  console.log(`Canonical deck hash (hex): 0x${hex}`);
  console.log();
  console.log(`pub const CANONICAL_DECK_HASH: [u8; 32] = [`);
  for (let i = 0; i < 32; i += 16) {
    const chunk = bytes.slice(i, i + 16);
    console.log(`    ${chunk.join(", ")},`);
  }
  console.log(`];`);
}

main().catch(console.error);
