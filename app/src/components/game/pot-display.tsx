/**
 * PotDisplay — large prominent display of the current pot in $FLIP.
 *
 * Pure presentational. The parent (GameBoard) reads `potAmount` from the
 * GameSession account and passes it down. The number is formatted with
 * locale-aware thousands separators and the FLIP_DECIMALS scaling
 * applied so the user sees "100" $FLIP rather than "100000000000" base
 * units.
 *
 * Animation: pulses briefly when the value increases. Implemented via a
 * useEffect that compares the current value to the previous render's
 * value — no Framer Motion dep yet (lands in Task 3.7.2).
 *
 * Spec: docs/EXECUTION_PLAN.md Task 3.3.5.
 */

import { useEffect, useRef, useState } from "react";

import { formatFlip } from "@/lib/flip-format";
import { cn } from "@/lib/utils";

export interface PotDisplayProps {
  /** Pot amount in base units (u64 scaled by FLIP_DECIMALS). */
  amount: bigint;
  className?: string;
}

export function PotDisplay({ amount, className }: PotDisplayProps) {
  const previousAmount = useRef(amount);
  const [pulseUp, setPulseUp] = useState(false);

  useEffect(() => {
    if (amount > previousAmount.current) {
      setPulseUp(true);
      const timer = setTimeout(() => setPulseUp(false), 600);
      previousAmount.current = amount;
      return () => clearTimeout(timer);
    }
    previousAmount.current = amount;
    return;
  }, [amount]);

  const formatted = formatFlip(amount);
  return (
    <div
      aria-label={`Pot: ${formatted} FLIP`}
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border-2 border-amber-500/40 bg-linear-to-br from-amber-950/40 via-amber-900/20 to-amber-950/40 p-4 transition-transform duration-300",
        pulseUp && "scale-105",
        className
      )}
      data-testid="pot-display"
      role="status"
    >
      <span
        aria-hidden="true"
        className="text-amber-300/80 text-xs uppercase tracking-widest"
      >
        Pot
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "font-bold font-mono text-3xl text-amber-200 tabular-nums",
          pulseUp && "text-amber-100"
        )}
      >
        {formatted}
      </span>
      <span aria-hidden="true" className="text-amber-300/60 text-xs">
        $FLIP
      </span>
    </div>
  );
}
