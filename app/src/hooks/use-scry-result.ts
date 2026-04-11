/**
 * `useScryResult` — detect when the connected player has just burned
 * for a scry and surface the result in a modal.
 *
 * **Scope caveat (important):**
 *
 * The peeked-card content cannot be displayed yet because the program
 * doesn't return the next card from `burn_scry` directly — the dealer
 * service is supposed to watch for the burn event and return the next
 * card via an off-chain channel. The dealer HTTP integration is the
 * separate stretch goal of Task 3.6.3 (the same wire-up needed for
 * `hit()` itself).
 *
 * What this hook DOES today:
 *  - Watches the connected wallet's PlayerState via `usePlayerState`
 *  - Detects when `hasUsedScry` flips false → true (exactly once per
 *    game; the on-chain enforcement guarantees no replays)
 *  - Exposes a `wasScried` boolean that the modal can show, plus a
 *    `dismiss` callback
 *  - Auto-dismisses 5 seconds after firing
 *
 * What this hook does NOT do today (deferred to Phase 4 / dealer
 * integration):
 *  - Show the actual peeked card. The modal renders a placeholder
 *    "Card revealed off-chain — see dealer" message instead.
 *
 * Spec: docs/EXECUTION_PLAN.md Task 3.6.3.
 */

import { useEffect, useRef, useState } from "react";

import { usePlayerState } from "@/hooks/use-player-state";
import { GAME_ID } from "@/lib/constants";

const AUTO_DISMISS_MS = 5000;

export interface UseScryResultResult {
  /** Manually dismiss the modal (e.g. user clicks "OK"). */
  dismiss: () => void;
  /** True if a scry burn just happened and the modal should be visible. */
  wasScried: boolean;
}

export function useScryResult(gameId: bigint = GAME_ID): UseScryResultResult {
  const playerQuery = usePlayerState(gameId);
  const [wasScried, setWasScried] = useState(false);
  const previousScryRef = useRef<boolean | null>(null);

  const player = playerQuery.data?.data ?? null;
  const currentScryFlag = player?.hasUsedScry ?? null;

  useEffect(() => {
    const prev = previousScryRef.current;
    previousScryRef.current = currentScryFlag;

    // Only fire on a clean false → true transition. Initial mount or
    // disconnect/reconnect should not trigger the modal.
    if (prev === false && currentScryFlag === true) {
      setWasScried(true);
    }
  }, [currentScryFlag]);

  // Auto-dismiss after AUTO_DISMISS_MS.
  useEffect(() => {
    if (!wasScried) {
      return;
    }
    const timer = setTimeout(() => setWasScried(false), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [wasScried]);

  return {
    wasScried,
    dismiss: () => setWasScried(false),
  };
}
