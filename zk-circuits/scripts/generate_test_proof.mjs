import { readFileSync, writeFileSync } from "fs";
import { buildPoseidon } from "circomlibjs";

// Canonical deck: 94 cards
// Alpha: 52 cards (suits 0-3, values 1-13)
// Protocol: 30 cards (10 RugPull=0, 10 Airdrop=1, 10 VampireAttack=2)
// Multiplier: 12 cards (4x2, 4x3, 4x5)
function createCanonicalDeck() {
  const values = [];
  const types = [];
  const suits = [];

  // 52 Alpha
  for (let suit = 0; suit < 4; suit++) {
    for (let value = 1; value <= 13; value++) {
      values.push(value);
      types.push(0); // ALPHA
      suits.push(suit);
    }
  }

  // 30 Protocol: 10 each of effects 0, 1, 2
  for (const effect of [0, 1, 2]) {
    for (let i = 0; i < 10; i++) {
      values.push(effect);
      types.push(1); // PROTOCOL
      suits.push(0);
    }
  }

  // 12 Multiplier: 4 each of 2, 3, 5
  for (const mult of [2, 3, 5]) {
    for (let i = 0; i < 4; i++) {
      values.push(mult);
      types.push(2); // MULTIPLIER
      suits.push(0);
    }
  }

  return { values, types, suits };
}

// Fisher-Yates shuffle returning the permutation indices
function shuffleDeck(deckSize) {
  const perm = Array.from({ length: deckSize }, (_, i) => i);
  for (let i = deckSize - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  return perm;
}

async function main() {
  const DECK_SIZE = 94;

  const { values, types, suits } = createCanonicalDeck();
  console.log(`Canonical deck: ${DECK_SIZE} cards`);

  // Generate a random permutation
  const permutation = shuffleDeck(DECK_SIZE);
  console.log(`Permutation generated (first 10): ${permutation.slice(0, 10)}`);

  // Build the Poseidon hasher
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  // Compute canonical hash (chain of Poseidon hashes)
  const cardHashes = [];
  for (let i = 0; i < DECK_SIZE; i++) {
    const h = poseidon([values[i], types[i], suits[i], i]);
    cardHashes.push(h);
  }

  let canonicalHash = cardHashes[0];
  for (let i = 1; i < DECK_SIZE; i++) {
    canonicalHash = poseidon([canonicalHash, cardHashes[i]]);
  }
  const canonicalHashStr = F.toObject(canonicalHash).toString();
  console.log(`Canonical hash: ${canonicalHashStr}`);

  // Compute shuffled deck leaf hashes
  const NUM_LEAVES = 128; // 2^7
  const leafHashes = [];

  for (let i = 0; i < DECK_SIZE; i++) {
    const srcIdx = permutation[i]; // canonical card at position i
    const h = poseidon([values[srcIdx], types[srcIdx], suits[srcIdx], i]);
    leafHashes.push(h);
  }

  // Padding leaves
  for (let i = DECK_SIZE; i < NUM_LEAVES; i++) {
    const h = poseidon([0, 0, 0, i]);
    leafHashes.push(h);
  }

  // Build Merkle tree
  let currentLevel = leafHashes;
  while (currentLevel.length > 1) {
    const nextLevel = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      nextLevel.push(poseidon([currentLevel[i], currentLevel[i + 1]]));
    }
    currentLevel = nextLevel;
  }
  const merkleRoot = currentLevel[0];
  const merkleRootStr = F.toObject(merkleRoot).toString();
  console.log(`Merkle root: ${merkleRootStr}`);

  // Write the circuit input
  const input = {
    merkle_root: merkleRootStr,
    canonical_hash: canonicalHashStr,
    permutation: permutation.map(String),
    canonical_values: values.map(String),
    canonical_types: types.map(String),
    canonical_suits: suits.map(String),
  };

  writeFileSync("build/input.json", JSON.stringify(input, null, 2));
  console.log("Written: build/input.json");
}

main().catch(console.error);
