/**
 * TurnIndicator — shows whose turn is currently active, highlighted
 * "Your turn!" if it's the connected wallet.
 *
 * Pure presentational. The parent passes the active player's address +
 * a boolean for "is this me". When `isMe` is true, the indicator pulses
 * with an amber accent to draw the eye.
 *
 * Spec: docs/EXECUTION_PLAN.md Task 3.3.5.
 */

import type { Address } from "@solana/kit";
import { motion } from "motion/react";

import { cn } from "@/lib/utils";

export interface TurnIndicatorProps {
  /** The active player's pubkey, or null if no one is active (round over / not started). */
  activePlayer: Address | null;
  /** Optional class on the wrapper. */
  className?: string;
  /** Optional override for the inactive state message. */
  emptyMessage?: string;
  /** True if `activePlayer` is the connected wallet. */
  isMe: boolean;
}

function shortAddress(addr: Address): string {
  const s = addr.toString();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

export function TurnIndicator({
  activePlayer,
  isMe,
  className,
  emptyMessage = "Waiting for round to start",
}: TurnIndicatorProps) {
  if (!activePlayer) {
    return (
      <div
        className={cn(
          "rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-center text-muted-foreground text-sm",
          className
        )}
        data-testid="turn-indicator"
      >
        {emptyMessage}
      </div>
    );
  }

  // motion.div for the "your turn" pulse: a subtle scale + opacity
  // loop that draws the eye without being annoying. Replaces the
  // earlier `animate-pulse` Tailwind built-in (which only opacities)
  // with a richer effect. The non-isMe state renders a static div,
  // not motion.div, so we don't pay any animation cost for the
  // common "waiting for someone else" case.
  if (isMe) {
    return (
      <motion.div
        animate={{ scale: [1, 1.025, 1], opacity: [0.95, 1, 0.95] }}
        className={cn(
          "rounded-md border-2 border-amber-500 bg-amber-100/70 px-3 py-2 text-center text-amber-900 text-sm dark:border-amber-400 dark:bg-amber-500/15 dark:text-amber-200",
          className
        )}
        data-testid="turn-indicator"
        transition={{
          duration: 1.6,
          repeat: Number.POSITIVE_INFINITY,
          ease: "easeInOut",
        }}
      >
        <span className="font-bold uppercase tracking-wider">Your turn!</span>
      </motion.div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-md border-2 border-border bg-muted/30 px-3 py-2 text-center text-foreground text-sm transition-colors",
        className
      )}
      data-testid="turn-indicator"
    >
      <span>
        Waiting for{" "}
        {/* `title` carries the full base58 so the user can hover-verify
            and the truncation can never produce a visual collision
            attack (heavy-duty review #10 finding #12). */}
        <span className="font-mono text-xs" title={activePlayer.toString()}>
          {shortAddress(activePlayer)}
        </span>
      </span>
    </div>
  );
}
