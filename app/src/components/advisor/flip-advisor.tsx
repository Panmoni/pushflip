/**
 * FlipAdvisor — collapsible probability advisor for the connected
 * player.
 *
 * Shows the bust probability with color coding (green/yellow/red),
 * the recommendation from `getRecommendation`, and a Degen Mode
 * toggle that always recommends HIT regardless of the math.
 *
 * The component reads the connected player's hand from `usePlayerState`
 * and runs the advisor math against it locally — no on-chain calls.
 *
 * Spec: docs/EXECUTION_PLAN.md Task 3.5.2.
 */

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { usePlayerState } from "@/hooks/use-player-state";
import { calculateBustProbability, getRecommendation } from "@/lib/advisor";
import { GAME_ID } from "@/lib/constants";
import { cn } from "@/lib/utils";

export interface FlipAdvisorProps {
  className?: string;
}

/** Pick a color class based on bust probability. */
function probabilityColor(prob: number): string {
  if (Number.isNaN(prob)) {
    return "text-muted-foreground";
  }
  if (prob < 0.2) {
    return "text-emerald-400";
  }
  if (prob < 0.4) {
    return "text-amber-400";
  }
  return "text-red-400";
}

/** Render the probability as a percentage string, or "—" if NaN. */
function probabilityLabel(prob: number): string {
  if (Number.isNaN(prob)) {
    return "—";
  }
  return `${Math.round(prob * 100)}%`;
}

export function FlipAdvisor({ className }: FlipAdvisorProps) {
  const playerQuery = usePlayerState(GAME_ID);
  const [collapsed, setCollapsed] = useState(false);
  const [degenMode, setDegenMode] = useState(false);

  const player = playerQuery.data?.data ?? null;

  // No hand to advise on (wallet disconnected, not joined, or PlayerState
  // still loading) — render a quiet skeleton.
  if (!player) {
    return (
      <section
        className={cn(
          "rounded-lg border border-border bg-card/50 p-3 text-card-foreground",
          className
        )}
      >
        <h3 className="font-semibold text-sm">Flip Advisor</h3>
        <p className="mt-1 text-muted-foreground text-xs">
          Join the game to get hit/stay recommendations.
        </p>
      </section>
    );
  }

  const bust = calculateBustProbability({ playerHand: player.hand });
  const recommendation = degenMode
    ? {
        recommendation: "hit" as const,
        reasoning: "Degen mode: always hit. Math is a suggestion.",
      }
    : getRecommendation({
        bustProbability: bust,
        score: Number(player.score),
      });

  const probColor = probabilityColor(bust.probability);
  const probString = probabilityLabel(bust.probability);

  return (
    <section
      className={cn(
        "rounded-lg border border-border bg-card p-3 text-card-foreground",
        className
      )}
    >
      <header className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">Flip Advisor</h3>
        <Button
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand advisor" : "Collapse advisor"}
          onClick={() => setCollapsed((c) => !c)}
          size="sm"
          variant="ghost"
        >
          {collapsed ? "▸" : "▾"}
        </Button>
      </header>

      {!collapsed && (
        <div className="mt-3 space-y-3">
          {/* Probability + color */}
          <div className="flex items-baseline justify-between">
            <span className="text-muted-foreground text-xs uppercase tracking-wider">
              Bust risk
            </span>
            <span
              className={cn(
                "font-bold font-mono text-2xl tabular-nums",
                probColor
              )}
            >
              {probString}
            </span>
          </div>

          {/* Bust card count */}
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-muted-foreground">Risky cards remaining</span>
            <span className="font-mono tabular-nums">
              {bust.bustingCardsRemaining} / {bust.remainingDeckSize}
            </span>
          </div>

          {/* Recommendation. `aria-live="polite"` so screen-reader users
              hear when the advice flips HIT → STAY mid-game without
              relying on the color change (heavy-duty review #10
              finding #7). */}
          <div
            aria-live="polite"
            className={cn(
              "rounded-md border-2 p-2",
              recommendation.recommendation === "hit"
                ? "border-emerald-500/40 bg-emerald-950/20"
                : "border-amber-500/40 bg-amber-950/20"
            )}
            role="status"
          >
            <div className="font-bold text-sm uppercase tracking-wider">
              {recommendation.recommendation === "hit" ? (
                <span className="text-emerald-300">Recommend: HIT</span>
              ) : (
                <span className="text-amber-300">Recommend: STAY</span>
              )}
            </div>
            <p className="mt-1 text-muted-foreground text-xs">
              {recommendation.reasoning}
            </p>
          </div>

          {/* Degen mode toggle */}
          <label className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              Degen Mode (always hit)
            </span>
            <input
              checked={degenMode}
              className="h-4 w-4 cursor-pointer accent-red-500"
              onChange={(e) => setDegenMode(e.target.checked)}
              type="checkbox"
            />
          </label>
        </div>
      )}
    </section>
  );
}
