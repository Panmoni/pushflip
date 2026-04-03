/**
 * Canonical deck definition — must match on-chain create_canonical_deck()
 * and the Circom circuit exactly.
 */

export const DECK_SIZE = 94;
export const NUM_LEAVES = 128; // 2^7
export const TREE_DEPTH = 7;

// Card types
export const ALPHA = 0;
export const PROTOCOL = 1;
export const MULTIPLIER = 2;

// Protocol effects
export const RUG_PULL = 0;
export const AIRDROP = 1;
export const VAMPIRE_ATTACK = 2;

export interface Card {
  value: number;
  cardType: number;
  suit: number;
}

/**
 * Creates the canonical 94-card deck in deterministic order.
 * Layout:
 * - 52 Alpha: suits 0-3, values 1-13
 * - 30 Protocol: 10 RugPull, 10 Airdrop, 10 VampireAttack
 * - 12 Multiplier: 4×2, 4×3, 4×5
 */
export function createCanonicalDeck(): Card[] {
  const deck: Card[] = [];

  // 52 Alpha cards: 4 suits × 13 values
  for (let suit = 0; suit < 4; suit++) {
    for (let value = 1; value <= 13; value++) {
      deck.push({ value, cardType: ALPHA, suit });
    }
  }

  // 30 Protocol cards
  for (const effect of [RUG_PULL, AIRDROP, VAMPIRE_ATTACK]) {
    for (let i = 0; i < 10; i++) {
      deck.push({ value: effect, cardType: PROTOCOL, suit: 0 });
    }
  }

  // 12 Multiplier cards
  for (const mult of [2, 3, 5]) {
    for (let i = 0; i < 4; i++) {
      deck.push({ value: mult, cardType: MULTIPLIER, suit: 0 });
    }
  }

  if (deck.length !== DECK_SIZE) {
    throw new Error(`Deck size mismatch: expected ${DECK_SIZE}, got ${deck.length}`);
  }

  return deck;
}

/**
 * Fisher-Yates shuffle using crypto.getRandomValues for secure randomness.
 * Returns a permutation array where perm[i] = index of canonical card that goes to shuffled position i.
 */
export function fisherYatesShuffle(): number[] {
  const perm = Array.from({ length: DECK_SIZE }, (_, i) => i);

  // Use crypto-quality randomness
  const randomBytes = new Uint32Array(DECK_SIZE);
  crypto.getRandomValues(randomBytes);

  for (let i = DECK_SIZE - 1; i > 0; i--) {
    const j = randomBytes[i] % (i + 1);
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }

  return perm;
}

/**
 * Apply a permutation to the canonical deck.
 * shuffled[i] = canonical[perm[i]]
 */
export function applyPermutation(canonical: Card[], perm: number[]): Card[] {
  return perm.map((srcIdx) => canonical[srcIdx]);
}
