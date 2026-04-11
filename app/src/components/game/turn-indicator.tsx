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

  return (
    <div
      className={cn(
        "rounded-md border-2 px-3 py-2 text-center text-sm transition-colors",
        isMe
          ? "animate-pulse border-amber-400 bg-amber-500/15 text-amber-200"
          : "border-border bg-muted/30 text-foreground",
        className
      )}
      data-testid="turn-indicator"
    >
      {isMe ? (
        <span className="font-bold uppercase tracking-wider">Your turn!</span>
      ) : (
        <span>
          Waiting for{" "}
          {/* `title` carries the full base58 so the user can hover-verify
              and the truncation can never produce a visual collision
              attack (heavy-duty review #10 finding #12). */}
          <span className="font-mono text-xs" title={activePlayer.toString()}>
            {shortAddress(activePlayer)}
          </span>
        </span>
      )}
    </div>
  );
}
