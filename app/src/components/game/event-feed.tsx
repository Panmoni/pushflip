/**
 * EventFeed — scrolling list of derived game events.
 *
 * Renders the events from `useGameEvents` (most recent first) with a
 * timestamp and a colored marker per event kind. Auto-scrolls back to
 * the top when new events arrive (since events are prepended).
 *
 * Spec: docs/EXECUTION_PLAN.md Task 3.6.2.
 */

import { useEffect, useRef } from "react";

import {
  type GameEvent,
  type GameEventKind,
  useGameEvents,
} from "@/hooks/use-game-events";
import { cn } from "@/lib/utils";

const EVENT_KIND_COLOR: Record<GameEventKind, string> = {
  PlayerJoined: "border-emerald-400/60 text-emerald-300",
  DeckCommitted: "border-blue-400/60 text-blue-300",
  RoundStarted: "border-amber-400/60 text-amber-300",
  TurnAdvanced: "border-cyan-400/60 text-cyan-300",
  PotChanged: "border-yellow-400/60 text-yellow-300",
  RoundEnded: "border-purple-400/60 text-purple-300",
};

export interface EventFeedProps {
  className?: string;
}

/**
 * Render a single event row.
 */
function EventRow({ event }: { event: GameEvent }) {
  const time = new Date(event.timestamp).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return (
    <li
      className={cn(
        "flex items-baseline gap-2 border-l-2 py-1 pl-2 text-xs",
        EVENT_KIND_COLOR[event.kind]
      )}
    >
      <span className="font-mono text-muted-foreground tabular-nums">
        {time}
      </span>
      <span>{event.message}</span>
    </li>
  );
}

export function EventFeed({ className }: EventFeedProps) {
  const { events } = useGameEvents();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Events are prepended to the top of the list, so the latest event is
  // at scrollTop=0. Snap back to the top whenever the head event id
  // changes — keeps the latest visible without trapping the user mid-
  // scroll if they're reading older events. (We could detect that with
  // a "stick to top" boolean, but for an MVP the simple snap is fine.)
  const headId = events[0]?.id ?? null;
  useEffect(() => {
    // headId is read here so biome's useExhaustiveDependencies rule sees
    // the dependency as both required and used — without this read it
    // would flag the dep as unused even though the effect must re-run
    // on every headId change.
    if (scrollRef.current && headId !== null) {
      scrollRef.current.scrollTop = 0;
    }
  }, [headId]);

  return (
    <section
      className={cn(
        "rounded-lg border border-border bg-card p-3 text-card-foreground",
        className
      )}
    >
      <header className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">Event feed</h3>
        <span className="text-muted-foreground text-xs tabular-nums">
          {events.length}
        </span>
      </header>

      <div className="mt-2 max-h-48 overflow-y-auto pr-1" ref={scrollRef}>
        {events.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            Waiting for activity… events appear here as players join, the deck
            commits, the round starts, turns advance, the pot changes, or the
            round ends.
          </p>
        ) : (
          <ul className="space-y-1">
            {events.map((event) => (
              <EventRow event={event} key={event.id} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
