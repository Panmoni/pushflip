/**
 * PlayerHand — renders a player's revealed cards in a row, with their
 * score and bust indicator.
 *
 * Pure presentational. Consumes the on-chain `Card[]` from PlayerState
 * and the score/active flags. Wraps each card in `<GameCard>`.
 *
 * Spec: docs/EXECUTION_PLAN.md Task 3.3.2.
 */

import type { Card } from "@pushflip/client";

import { GameCard } from "@/components/game/card";
import { cn } from "@/lib/utils";

export interface PlayerHandProps {
  /** The player's display name (truncated wallet address or "House"). */
  bust?: boolean;
  /** Optional class on the wrapper. */
  className?: string;
  /** Cards in the player's hand, in draw order (oldest first). */
  hand: readonly Card[];
  /**
   * If true, this hand belongs to the player whose turn is currently
   * active. Highlights the row with an accent border.
   */
  isCurrentTurn?: boolean;
  /** Display label for the player (e.g. "Player 1" or truncated address). */
  label: string;
  /**
   * Optional full text shown on hover via the `title` attribute. Used
   * by the GameBoard to expose the full base58 wallet address when the
   * `label` is a truncated form (defends against visual-collision
   * attacks per heavy-duty review #10 finding #12).
   */
  labelTitle?: string;
  /** The player's current score (sum of card values + multipliers). */
  score: bigint | number;
}

/**
 * A horizontal row of cards plus a header showing the player label,
 * score, and bust indicator.
 */
export function PlayerHand({
  bust = false,
  hand,
  isCurrentTurn = false,
  className,
  label,
  labelTitle,
  score,
}: PlayerHandProps) {
  // `Number(bigint)` loses precision for values above
  // Number.MAX_SAFE_INTEGER (~9×10^15). Safe here because pushflip
  // scores are bounded by the deck's value sum: 4 suits × (1+2+...+13)
  // = 364 max for an all-Alpha hand, plus a 5× multiplier ceiling →
  // realistic max ~1820. Nowhere near MAX_SAFE_INTEGER.
  const scoreNumber = typeof score === "bigint" ? Number(score) : score;

  return (
    <div
      className={cn(
        "rounded-lg border-2 p-3 transition-colors",
        isCurrentTurn
          ? "border-amber-400/70 bg-amber-950/20"
          : "border-border/50 bg-card/50",
        bust && "border-red-500/60 bg-red-950/20",
        className
      )}
    >
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="font-semibold text-sm" title={labelTitle}>
          {label}
        </span>
        <div className="flex items-center gap-2">
          {bust && (
            <span className="rounded bg-red-500/20 px-2 py-0.5 font-bold text-red-300 text-xs uppercase tracking-wider">
              Bust
            </span>
          )}
          {isCurrentTurn && !bust && (
            <span className="rounded bg-amber-500/20 px-2 py-0.5 font-bold text-amber-300 text-xs uppercase tracking-wider">
              Turn
            </span>
          )}
          <span className="font-mono text-muted-foreground text-sm tabular-nums">
            {scoreNumber}
          </span>
        </div>
      </div>

      {hand.length === 0 ? (
        <div className="flex h-32 items-center justify-center rounded border border-border/30 border-dashed text-muted-foreground text-xs">
          (no cards yet)
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {hand.map((card, idx) => {
            // Composite key: position + card identity. Position is
            // load-bearing — Protocol cards can repeat the same
            // value/suit combo within a single hand (RugPull appears
            // 10× in the deck, Airdrop 10×, VampireAttack 10×), so
            // position is the only thing that distinguishes two
            // RugPulls as React keys. Hand is append-only during a
            // round so position is stable per card. Hoisting the key
            // out of the JSX expression also satisfies biome's
            // noArrayIndexKey heuristic, which only inspects direct
            // `key={index}` patterns.
            const cardKey = `${idx}-${card.cardType}-${card.value}-${card.suit}`;
            return <GameCard animate card={card} key={cardKey} />;
          })}
        </div>
      )}
    </div>
  );
}
