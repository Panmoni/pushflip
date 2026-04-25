/**
 * EventFeed — scrolling list of on-chain game events.
 *
 * Consumes the new on-chain log stream via `useGameEvents` (Pre-Mainnet
 * 5.0.9 PR 2). Each row renders a human-readable message plus a link to
 * the signature on Solana Explorer; skeletons appear during the initial
 * backfill.
 */

import { useEffect, useRef } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { type GameEvent, useGameEvents } from "@/hooks/use-game-events";
import {
  EVENT_CATEGORY,
  explorerTxUrl,
  type GameEventCategory,
  renderEventMessage,
} from "@/lib/event-render";
import { cn } from "@/lib/utils";

// Theme-aware tag palette keyed by coarse category (8 buckets, not 16 —
// same pattern as the previous diff-based version). Light mode uses
// `-700` text on pale card background for AA contrast, dark mode uses
// `-300`.
const CATEGORY_COLOR: Record<GameEventCategory, string> = {
  admin: "border-slate-400/60 text-slate-700 dark:text-slate-300",
  lifecycle: "border-purple-400/60 text-purple-700 dark:text-purple-300",
  deck: "border-blue-400/60 text-blue-700 dark:text-blue-300",
  "join-leave": "border-emerald-400/60 text-emerald-700 dark:text-emerald-300",
  hit: "border-amber-400/60 text-amber-700 dark:text-amber-300",
  stay: "border-cyan-400/60 text-cyan-700 dark:text-cyan-300",
  burn: "border-orange-400/60 text-orange-700 dark:text-orange-300",
  bounty: "border-yellow-500/60 text-yellow-700 dark:text-yellow-300",
};

// Stable, non-numeric keys for skeleton rows. Using the array index as
// `key` trips biome's `noArrayIndexKey` rule — warranted in general but
// these rows are never reordered and never keyed to persistent state.
const SKELETON_KEYS = ["a", "b", "c", "d"] as const;

export interface EventFeedProps {
  className?: string;
}

function formatEventTime(event: GameEvent): string {
  // `blockTime` is Unix seconds, best-effort: chain truth for backfill
  // rows, wall-clock-on-arrival for live rows (the `logsNotifications`
  // payload doesn't include a real blockTime, and an extra
  // `getBlockTime(slot)` per live event isn't worth the RPC). The rare
  // `null` case (old / pruned blocks without blockTime) falls back to
  // the slot number so rows are never unlabeled.
  if (event.blockTime !== null) {
    return new Date(event.blockTime * 1000).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }
  return `slot ${event.slot.toString()}`;
}

function EventRow({ event }: { event: GameEvent }) {
  const category = EVENT_CATEGORY[event.kind];
  const message = renderEventMessage(event);
  const time = formatEventTime(event);
  return (
    <li
      className={cn(
        "flex items-baseline gap-2 border-l-2 py-1 pl-2 text-xs",
        CATEGORY_COLOR[category]
      )}
    >
      <span className="font-mono text-muted-foreground tabular-nums">
        {time}
      </span>
      <span className="flex-1">{message}</span>
      <a
        className="font-mono text-[10px] text-muted-foreground underline-offset-2 hover:underline"
        href={explorerTxUrl(event.signature)}
        rel="noopener noreferrer"
        target="_blank"
        title="View transaction on Solana Explorer"
      >
        tx
      </a>
    </li>
  );
}

function EventRowSkeleton() {
  return (
    <li className="flex items-center gap-2 py-1 pl-2">
      <Skeleton className="h-3 w-14" />
      <Skeleton className="h-3 flex-1" />
      <Skeleton className="h-3 w-6" />
    </li>
  );
}

export function EventFeed({ className }: EventFeedProps) {
  const { events, isBackfilling } = useGameEvents();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Events are prepended (newest first), so the latest is at scrollTop=0.
  // Snap back to the top when the head changes so the latest stays visible
  // without trapping a user mid-scroll. `useExhaustiveDependencies` wants
  // the id read in the effect body; without it the rule thinks the dep is
  // unused even though we're using it to trigger.
  const headId = events[0]?.id ?? null;
  useEffect(() => {
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
          {isBackfilling ? "…" : events.length}
        </span>
      </header>

      <div className="mt-2 max-h-48 overflow-y-auto pr-1" ref={scrollRef}>
        {renderBody({ events, isBackfilling })}
      </div>
    </section>
  );
}

/**
 * Split out the body so the main component stays under biome's
 * cognitive-complexity threshold. Three branches: initial backfill
 * (skeletons), backfill-complete-but-no-events (empty state), normal
 * render (list).
 */
function renderBody({
  events,
  isBackfilling,
}: {
  events: readonly GameEvent[];
  isBackfilling: boolean;
}) {
  if (isBackfilling && events.length === 0) {
    return (
      <ul className="space-y-1">
        {SKELETON_KEYS.map((k) => (
          <EventRowSkeleton key={k} />
        ))}
      </ul>
    );
  }
  if (events.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        Waiting for activity… events appear here as players join, the deck
        commits, the round starts, turns advance, or the pot changes.
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {events.map((event) => (
        <EventRow event={event} key={event.id} />
      ))}
    </ul>
  );
}
