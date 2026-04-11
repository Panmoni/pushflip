/**
 * ActionButtons — the four in-game player actions.
 *
 * Hit / Stay / Second Chance / Scry. Each button is wired to a mutation
 * on `useGameActions` and respects the hook's `isPending` flag for the
 * disabled state. The hook's intrinsic re-entry guard catches double-
 * clicks regardless — the disable here is the UX layer.
 *
 * The component is "dumb" in the sense that it does not know game state
 * (whose turn it is, whether the player has busted, etc.). The PARENT
 * (typically GameBoard) decides which buttons are enabled by passing
 * `canHit` / `canStay` / `canSecondChance` / `canScry`. This keeps the
 * gating logic in one place (the parent that owns the game state) and
 * avoids prop-drilling the entire GameSession + PlayerState down here.
 *
 * Spec: docs/EXECUTION_PLAN.md Task 3.3.3.
 */

import { Button } from "@/components/ui/button";
import { useGameActions } from "@/hooks/use-game-actions";
import { cn } from "@/lib/utils";

export interface ActionButtonsProps {
  /** True if Hit is a valid action right now (your turn, not busted, dealer connected). */
  canHit?: boolean;
  /** True if a scry burn is allowed (your turn, haven't burned yet). */
  canScry?: boolean;
  /** True if a second-chance burn is allowed (you've busted, haven't burned yet). */
  canSecondChance?: boolean;
  /** True if Stay is a valid action right now (your turn, not busted). */
  canStay?: boolean;
  /** Optional class on the wrapper. */
  className?: string;
}

export function ActionButtons({
  canHit = false,
  canStay = false,
  canSecondChance = false,
  canScry = false,
  className,
}: ActionButtonsProps) {
  const actions = useGameActions();
  const { isPending } = actions;

  // Each button swallows its own promise rejection inside the click handler
  // so an unhandled rejection from `mutateAsync` doesn't bubble up to the
  // window. The toast is already raised by `runAction` inside the hook on
  // both success and failure paths, so the click handler doesn't need to
  // do its own user-facing error reporting.
  function fireAndForget(fn: () => Promise<unknown>) {
    return () => {
      fn().catch(() => {
        // No-op: the user-facing toast is raised inside the hook's
        // runAction wrapper. We catch here only so the unhandled-promise
        // window warning doesn't fire.
      });
    };
  }

  return (
    <div
      className={cn("flex flex-wrap gap-2", className)}
      data-testid="action-buttons"
    >
      <Button
        disabled={isPending || !canHit}
        onClick={fireAndForget(() => actions.hit())}
        variant="default"
      >
        Hit
      </Button>
      <Button
        disabled={isPending || !canStay}
        onClick={fireAndForget(() => actions.stay())}
        variant="secondary"
      >
        Stay
      </Button>
      <Button
        disabled={isPending || !canSecondChance}
        onClick={fireAndForget(() => actions.burnSecondChance())}
        title="Burn 50 $FLIP to recover from a bust"
        variant="outline"
      >
        Second Chance
        <span className="ml-1.5 text-muted-foreground text-xs tabular-nums">
          50 $FLIP
        </span>
      </Button>
      <Button
        disabled={isPending || !canScry}
        onClick={fireAndForget(() => actions.burnScry())}
        title="Burn 25 $FLIP to peek at the next card"
        variant="outline"
      >
        Scry
        <span className="ml-1.5 text-muted-foreground text-xs tabular-nums">
          25 $FLIP
        </span>
      </Button>
    </div>
  );
}
