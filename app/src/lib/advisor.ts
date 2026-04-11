/**
 * Flip Advisor — pure frontend math.
 *
 * Calculates the probability of busting on the next `hit` and produces
 * a recommendation (HIT or STAY) based on simple heuristics. No
 * blockchain calls; the math runs against whatever cards have been
 * publicly revealed so far.
 *
 * **Bust rules in PushFlip:**
 *
 * Looking at the canonical deck (program/src/utils/deck.rs):
 *   - 52 Alpha cards: 4 suits × 13 values (1-13)
 *   - 30 Protocol cards: 10 RugPull, 10 Airdrop, 10 VampireAttack
 *   - 12 Multiplier cards: 4×2, 4×3, 4×5
 *
 * The bust trigger in this game is: drawing an Alpha card whose
 * **value** matches one already in the player's hand. Each Alpha value
 * (1-13) appears 4 times in the deck, once per suit. If the player has
 * already revealed an Alpha 7 of any suit, the next Alpha 7 of any
 * other suit busts them.
 *
 * Protocol and Multiplier cards have no value-collision rule and never
 * directly bust the player on draw.
 *
 * **Probability formula:**
 *
 *     P(bust on next hit) = (cards remaining in deck that would bust)
 *                         / (total cards remaining in deck)
 *
 * Where:
 *   - "remaining" = full deck (94) minus everything already revealed
 *     across the entire game (the player's hand + every other player's
 *     hand + any publicly burned cards from scry/etc.)
 *   - "would bust" = Alpha cards whose value matches an Alpha value
 *     the player already holds
 *
 * Spec: docs/EXECUTION_PLAN.md Task 3.5.1.
 */

import { type Card, CardType, DECK_SIZE } from "@pushflip/client";

/**
 * Cards that have been publicly revealed so far in the game, used to
 * narrow the "remaining deck" denominator. Pass the union of every
 * player's revealed hand here. Currently the frontend only sees the
 * connected player's own hand (Phase 3.6.1's useGameEvents will add
 * other players' card draws via event subscriptions); for now this is
 * conservative — passing only your own hand still gives a usable
 * probability estimate.
 */
export interface BustProbabilityInput {
  /** Cards revealed by other sources (other players' draws, scry burns, etc.). */
  otherRevealedCards?: readonly Card[];
  /** The connected player's current hand (revealed cards). */
  playerHand: readonly Card[];
}

export interface BustProbabilityResult {
  /** Number of bust-causing cards remaining in the deck. */
  bustingCardsRemaining: number;
  /** Probability in [0, 1]. NaN if the deck is fully exhausted (degenerate). */
  probability: number;
  /** Number of cards remaining in the deck. */
  remainingDeckSize: number;
  /**
   * The set of Alpha values currently in the player's hand (1-13).
   * Returned for the recommendation logic and for UI display.
   */
  riskyValues: readonly number[];
}

/**
 * For each Alpha value (1-13), how many copies of that value exist in
 * the canonical deck. Each value appears once per suit (4 suits) =
 * 4 copies. Multiplier and Protocol cards do not contribute to bust
 * probability.
 */
const ALPHA_VALUE_COPIES_IN_DECK = 4;

/**
 * Compute the probability that the next `hit` will bust the player.
 *
 * Returns NaN for `probability` if the deck is fully exhausted (more
 * cards revealed than the deck contains — should never happen in a
 * well-formed game, but defensive).
 */
export function calculateBustProbability(
  input: BustProbabilityInput
): BustProbabilityResult {
  const playerHand = input.playerHand;
  const otherRevealedCards = input.otherRevealedCards ?? [];

  // Set of Alpha values the player already holds. These are the values
  // that would bust them if drawn again.
  const playerAlphaValues = new Set<number>();
  for (const card of playerHand) {
    if (card.cardType === CardType.Alpha) {
      playerAlphaValues.add(card.value);
    }
  }

  // For each risky Alpha value, count how many of the 4 copies have
  // been revealed (in the player's own hand OR in any other revealed
  // source). The remaining copies are still in the deck and would
  // bust the player on draw.
  let bustingCardsRemaining = 0;
  for (const value of playerAlphaValues) {
    let revealedCopies = 0;
    for (const c of playerHand) {
      if (c.cardType === CardType.Alpha && c.value === value) {
        revealedCopies++;
      }
    }
    for (const c of otherRevealedCards) {
      if (c.cardType === CardType.Alpha && c.value === value) {
        revealedCopies++;
      }
    }
    bustingCardsRemaining += Math.max(
      0,
      ALPHA_VALUE_COPIES_IN_DECK - revealedCopies
    );
  }

  const totalRevealed = playerHand.length + otherRevealedCards.length;
  const remainingDeckSize = DECK_SIZE - totalRevealed;
  const probability =
    remainingDeckSize <= 0
      ? Number.NaN
      : bustingCardsRemaining / remainingDeckSize;

  return {
    probability,
    remainingDeckSize,
    bustingCardsRemaining,
    riskyValues: Array.from(playerAlphaValues).sort((a, b) => a - b),
  };
}

/**
 * Recommendation produced by the advisor.
 */
export type Recommendation = "hit" | "stay";

export interface RecommendationInput {
  /** Output from `calculateBustProbability`. */
  bustProbability: BustProbabilityResult;
  /** Optional pot size (used as a tiebreaker for borderline scores). */
  potSize?: bigint;
  /** The player's current score. */
  score: number;
}

export interface RecommendationResult {
  /** A short, copy-pasteable explanation suitable for the UI. */
  reasoning: string;
  recommendation: Recommendation;
}

/**
 * The "stay if score > threshold and bust risk > threshold" heuristic
 * from the spec.
 *
 * The defaults are tuned for a 94-card deck and a score range that
 * tops out around 30 for typical Alpha-heavy hands. Tunable later.
 */
const SCORE_STAY_THRESHOLD = 15;
const BUST_PROB_STAY_THRESHOLD = 0.3;

/**
 * Decide whether the player should HIT or STAY.
 *
 * Heuristics:
 *   1. If bust probability > 30% AND score > 15 → STAY
 *   2. Otherwise → HIT
 *
 * The thresholds are intentionally simple. A real player will quickly
 * learn to override the advisor in obvious cases (e.g. score = 28 with
 * 5% bust risk → still STAY because the marginal upside is tiny). The
 * advisor's job is to surface the math, not to play optimally.
 */
export function getRecommendation(
  input: RecommendationInput
): RecommendationResult {
  const { bustProbability, score } = input;
  const probPercent = Math.round(bustProbability.probability * 100);

  if (Number.isNaN(bustProbability.probability)) {
    return {
      recommendation: "stay",
      reasoning: "Deck exhausted — no more cards to draw.",
    };
  }

  if (
    bustProbability.probability > BUST_PROB_STAY_THRESHOLD &&
    score > SCORE_STAY_THRESHOLD
  ) {
    return {
      recommendation: "stay",
      reasoning: `Bust risk is ${probPercent}% and you're already at ${score}. Locking it in.`,
    };
  }

  if (bustProbability.bustingCardsRemaining === 0) {
    return {
      recommendation: "hit",
      reasoning:
        "Zero bust risk — none of your held values are still in the deck.",
    };
  }

  return {
    recommendation: "hit",
    reasoning: `Bust risk is only ${probPercent}% — keep going.`,
  };
}
