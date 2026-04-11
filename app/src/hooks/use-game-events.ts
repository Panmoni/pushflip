/**
 * `useGameEvents` — derive a stream of human-readable game events from
 * GameSession state changes.
 *
 * **Why state diffs instead of program logs:**
 *
 * The pushflip program does not currently emit structured events via
 * `pinocchio_log` — only one log call exists in the entire program (an
 * error path in `commit_deck`). Building this hook on top of
 * `logsNotifications` would require waiting for the program to add
 * dedicated event-emission logs to every state-changing instruction
 * (a separate, larger task).
 *
 * Instead, we derive events from the diff between the previous and
 * current GameSession snapshots that the existing `useGameSession`
 * subscription is already pulling into the cache. Whenever the cached
 * value changes, we compare relevant fields and synthesize semantic
 * events: PlayerJoined, RoundStarted, DeckCommitted, TurnAdvanced,
 * PotChanged, RoundEnded.
 *
 * This is a derived view, not authoritative — if the program later
 * starts emitting real event logs, this hook can be reimplemented in
 * place against `logsNotifications` and the consumer API stays the
 * same. The EventFeed component is unchanged.
 *
 * Spec: docs/EXECUTION_PLAN.md Task 3.6.1.
 */

import type { GameSession } from "@pushflip/client";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useGameSession } from "@/hooks/use-game-session";
import { GAME_ID } from "@/lib/constants";

export type GameEventKind =
  | "PlayerJoined"
  | "DeckCommitted"
  | "RoundStarted"
  | "TurnAdvanced"
  | "PotChanged"
  | "RoundEnded";

export interface GameEvent {
  /** Unique event id (monotonic counter, not random — keeps the React keys stable). */
  id: number;
  kind: GameEventKind;
  /** Short, human-readable label suitable for both toast and feed. */
  message: string;
  /** ISO timestamp string for the event log display. */
  timestamp: string;
}

const MAX_EVENT_HISTORY = 50;

interface UseGameEventsResult {
  /**
   * Manually clear the event log. Currently UNUSED — exposed for the
   * Phase 4 round-end UX (clear the previous round's history when a
   * new round starts so the feed doesn't grow unbounded across many
   * rounds in the same game). Heavy-duty review #10 finding #10:
   * intentionally kept on the API surface as a forward declaration.
   */
  clear: () => void;
  events: readonly GameEvent[];
}

/**
 * Pure diff function — compare two GameSession snapshots and emit
 * derived events for each meaningful change. Extracted out of the
 * effect body so the effect itself stays below biome's
 * noExcessiveCognitiveComplexity threshold.
 *
 * `nextId` is a callback that produces the next monotonic id (the
 * caller owns the counter so the ids stay stable across diffs).
 */
function diffGameSessions(
  prev: GameSession,
  current: GameSession,
  nextId: () => number,
  timestamp: string
): GameEvent[] {
  const out: GameEvent[] = [];
  const make = (kind: GameEventKind, message: string): GameEvent => ({
    id: nextId(),
    kind,
    timestamp,
    message,
  });

  if (current.playerCount > prev.playerCount) {
    const delta = current.playerCount - prev.playerCount;
    const message =
      delta === 1
        ? `A player joined (${current.playerCount} total)`
        : `${delta} players joined (${current.playerCount} total)`;
    out.push(make("PlayerJoined", message));
  }

  if (!prev.deckCommitted && current.deckCommitted) {
    out.push(make("DeckCommitted", "Dealer committed the shuffled deck"));
  }

  if (!prev.roundActive && current.roundActive) {
    out.push(
      make("RoundStarted", `Round ${current.roundNumber.toString()} started`)
    );
  }

  if (prev.roundActive && !current.roundActive) {
    out.push(make("RoundEnded", `Round ${prev.roundNumber.toString()} ended`));
  }

  if (
    current.roundActive &&
    prev.roundActive &&
    prev.currentTurnIndex !== current.currentTurnIndex
  ) {
    out.push(
      make("TurnAdvanced", `Turn advanced to seat ${current.currentTurnIndex}`)
    );
  }

  if (prev.potAmount !== current.potAmount && current.potAmount > 0n) {
    const direction = current.potAmount > prev.potAmount ? "↑" : "↓";
    out.push(
      make("PotChanged", `Pot ${direction} ${current.potAmount.toString()}`)
    );
  }

  return out;
}

/**
 * Subscribe to a game and emit derived events as the cached account
 * changes. Returns the running event log (most recent first).
 *
 * Toasts every event by default; the EventFeed component renders the
 * full history below the game board.
 */
export function useGameEvents(gameId: bigint = GAME_ID): UseGameEventsResult {
  const gameQuery = useGameSession(gameId);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const previousRef = useRef<GameSession | null>(null);
  const counterRef = useRef(0);

  const game = gameQuery.data?.data ?? null;

  useEffect(() => {
    const prev = previousRef.current;
    previousRef.current = game;

    // First snapshot — nothing to diff against. Don't emit any events.
    if (prev === null || game === null) {
      return;
    }

    const nextId = () => {
      counterRef.current += 1;
      return counterRef.current;
    };
    const newEvents = diffGameSessions(
      prev,
      game,
      nextId,
      new Date().toISOString()
    );

    if (newEvents.length === 0) {
      return;
    }

    // Toast each new event so users get real-time feedback.
    for (const event of newEvents) {
      toast(event.message);
    }

    // Prepend (most recent first) and cap history. `toReversed()` is
    // ES2023 — non-mutating; cleaner than the previous `.reverse()`
    // which mutated `newEvents` in place. Heavy-duty review #10
    // finding #5.
    setEvents((current) =>
      [...newEvents.toReversed(), ...current].slice(0, MAX_EVENT_HISTORY)
    );
  }, [game]);

  return {
    events,
    clear: () => setEvents([]),
  };
}
