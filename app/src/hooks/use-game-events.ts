/**
 * `useGameEvents` — build an authoritative event feed for a game from
 * the `pushflip:<kind>:...` log lines the program emits on every
 * state-changing instruction (Pre-Mainnet 5.0.9 PR 1, deployed
 * 2026-04-15).
 *
 * **Why this replaces the state-diff approach (Pre-Mainnet 5.0.9 PR 2):**
 *
 * The previous implementation reconstructed events by diffing consecutive
 * `GameSession` snapshots this browser happened to witness. That had three
 * problems: (1) not authoritative — a second device saw a different feed;
 * (2) died on refresh — held only in React state; (3) couldn't answer
 * "what happened before I opened this tab?". This hook fixes all three
 * by reading the program's log lines directly from two sources:
 *
 * - Historical backfill via `getSignaturesForAddress({limit: 50})` +
 *   `getTransaction` in concurrent batches of 10.
 * - Live stream via `logsNotifications({mentions: [gamePda]})`.
 *
 * **Critical ordering:** the subscription is opened FIRST, then backfill
 * runs second. Opening in reverse would leave a silent gap: any event
 * produced between `getSignaturesForAddress` returning and the WebSocket
 * being established would be dropped forever. With subscribe-first,
 * anything that fires during backfill is buffered by the live loop and
 * merged via id-keyed dedupe.
 *
 * **Sort key:** `(slot DESC, logIndex DESC)`. NOT `Date.now()` — the
 * client's mount time is not related to when a backfilled event
 * actually happened, so a wall-clock sort would scramble the feed.
 *
 * **Toast policy:** toast only new LIVE events. Backfill inserts
 * silently — we don't want the user to see 50 toasts spray on page load.
 */

import {
  deriveGamePda,
  type GameEvent,
  parseTransactionEvents,
} from "@pushflip/client";
import type { Address, Signature, Slot, UnixTimestamp } from "@solana/kit";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { GAME_ID } from "@/lib/constants";
import { renderEventMessage } from "@/lib/event-render";
import { logError } from "@/lib/logger";
import { rpc, rpcSubscriptions } from "@/lib/program";

// Re-export so consumers can `import type { GameEvent } from "@/hooks/..."`
// without reaching into the client package directly.
export type { GameEvent, GameEventKind } from "@pushflip/client";

const MAX_EVENTS = 200;
const BACKFILL_SIGNATURE_LIMIT = 50;
const BACKFILL_TRANSACTION_BATCH = 10;

interface UseGameEventsResult {
  clear: () => void;
  events: readonly GameEvent[];
  /**
   * True from mount until the initial backfill completes. `EventFeed`
   * uses this to show skeleton rows instead of the empty-state copy.
   */
  isBackfilling: boolean;
}

/**
 * Compare two GameEvents by (slot DESC, logIndex DESC). Extracted so
 * the sort comparator is reused across merges instead of recreated.
 */
function byRecency(a: GameEvent, b: GameEvent): number {
  if (a.slot !== b.slot) {
    return a.slot > b.slot ? -1 : 1;
  }
  return b.logIndex - a.logIndex;
}

type SigInfo = Readonly<{ signature: Signature }>;
type TxResult = Awaited<
  ReturnType<ReturnType<typeof rpc.getTransaction>["send"]>
>;

/**
 * Absorb a single `(sigInfo, getTransaction result)` pair into the
 * feed. Extracted from `backfillEvents` so the outer loop stays under
 * biome's cognitive-complexity budget.
 */
function absorbBackfillTx(
  sigInfo: SigInfo,
  result: PromiseSettledResult<TxResult>,
  absorb: (events: readonly GameEvent[]) => void
): void {
  if (result.status === "rejected") {
    logError("useGameEvents.getTransaction", result.reason);
    return;
  }
  const tx = result.value;
  if (!tx?.meta || tx.meta.err !== null) {
    return;
  }
  const logs = tx.meta.logMessages;
  if (!logs) {
    return;
  }
  const parsed = parseTransactionEvents(
    sigInfo.signature,
    tx.slot,
    toUnixSeconds(tx.blockTime),
    logs
  );
  if (parsed.length > 0) {
    absorb(parsed);
  }
}

/**
 * Fetch one page of recent signatures + their transactions and parse
 * every pushflip event line out of the logs. Runs in the background
 * while the live subscription feeds the hook — race is harmless, dedupe
 * by `event.id` handles overlap.
 */
async function backfillEvents(
  pda: Address,
  absorb: (events: readonly GameEvent[]) => void,
  abortSignal: AbortSignal
): Promise<void> {
  const sigInfos = await rpc
    .getSignaturesForAddress(pda, {
      limit: BACKFILL_SIGNATURE_LIMIT,
      commitment: "confirmed",
    })
    .send();

  // Drop failed txs up front — the program reverts state on error, so
  // log lines from failed txs are runtime noise we don't want to render.
  const successful = sigInfos.filter((s) => s.err === null);

  for (
    let start = 0;
    start < successful.length;
    start += BACKFILL_TRANSACTION_BATCH
  ) {
    if (abortSignal.aborted) {
      return;
    }
    const batch = successful.slice(start, start + BACKFILL_TRANSACTION_BATCH);
    // `allSettled` (not `all`) so one failing `getTransaction` — a flaky
    // RPC, a 429, a tx the node hasn't retained — doesn't drop the whole
    // batch. Rejections are logged and the batch continues.
    const results = await Promise.allSettled(
      batch.map((s) =>
        rpc
          .getTransaction(s.signature, {
            encoding: "json",
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed",
          })
          .send()
      )
    );
    for (let i = 0; i < batch.length; i++) {
      const sigInfo = batch[i];
      const result = results[i];
      if (sigInfo && result) {
        absorbBackfillTx(sigInfo, result, absorb);
      }
    }
  }
}

function toUnixSeconds(
  blockTime: UnixTimestamp | null | undefined
): number | null {
  if (blockTime === null || blockTime === undefined) {
    return null;
  }
  // UnixTimestamp is branded bigint; Unix seconds are well under 2^53.
  return Number(blockTime);
}

/**
 * Insert new events into the id-keyed Map, dedupe, optionally toast
 * live ones. Returns `true` if any event was new (the caller uses this
 * to decide whether to push a fresh sorted snapshot to React state).
 */
function insertEvents(
  eventsById: Map<string, GameEvent>,
  newEvents: readonly GameEvent[],
  shouldToast: boolean
): boolean {
  let changed = false;
  for (const ev of newEvents) {
    if (eventsById.has(ev.id)) {
      continue;
    }
    eventsById.set(ev.id, ev);
    changed = true;
    if (shouldToast) {
      tryToast(ev);
    }
  }
  return changed;
}

function tryToast(ev: GameEvent): void {
  try {
    toast(renderEventMessage(ev));
  } catch (error) {
    // Renderer throwing shouldn't kill the feed. Log and move on.
    logError("useGameEvents.render", error);
  }
}

/**
 * Drain the logsNotifications async iterator until aborted, absorbing
 * each matching event into the local buffer. Errors that aren't caused
 * by the abort bubble up to the caller.
 *
 * The subscription payload does NOT include `blockTime`, so we stamp
 * wall-clock-on-arrival as an approximation. This matches the previous
 * state-diff hook's behavior (it used `new Date().toISOString()` on
 * detection) and keeps live rows showing a real time instead of a raw
 * slot number. Backfilled events already carry the node's `blockTime`
 * from `getTransaction` and don't need this approximation.
 */
async function drainSubscription(
  notifications: AsyncIterable<{
    readonly context: { readonly slot: Slot };
    readonly value: {
      readonly err: unknown;
      readonly logs: readonly string[];
      readonly signature: Signature;
    };
  }>,
  absorb: (events: readonly GameEvent[], opts: { toast: boolean }) => void
): Promise<void> {
  for await (const notification of notifications) {
    if (notification.value.err !== null) {
      continue;
    }
    const parsed = parseTransactionEvents(
      notification.value.signature,
      notification.context.slot,
      Math.floor(Date.now() / 1000),
      notification.value.logs
    );
    if (parsed.length > 0) {
      absorb(parsed, { toast: true });
    }
  }
}

export function useGameEvents(gameId: bigint = GAME_ID): UseGameEventsResult {
  const [events, setEvents] = useState<readonly GameEvent[]>([]);
  const [isBackfilling, setIsBackfilling] = useState(true);

  useEffect(() => {
    const abortController = new AbortController();
    const eventsById = new Map<string, GameEvent>();
    let isMounted = true;

    const absorb = (
      newEvents: readonly GameEvent[],
      opts: { toast: boolean }
    ): void => {
      if (!isMounted) {
        return;
      }
      const changed = insertEvents(eventsById, newEvents, opts.toast);
      if (!changed) {
        return;
      }
      const sorted = Array.from(eventsById.values())
        .sort(byRecency)
        .slice(0, MAX_EVENTS);
      setEvents(sorted);
    };

    const run = async (): Promise<void> => {
      const [pda] = await deriveGamePda(gameId);

      // Subscription FIRST so we don't drop anything during backfill.
      const notifications = await rpcSubscriptions
        .logsNotifications({ mentions: [pda] }, { commitment: "confirmed" })
        .subscribe({ abortSignal: abortController.signal });

      // Backfill runs alongside the live loop. No await — we want the
      // drain below to start consuming events the instant the subscription
      // is established. Any overlap with backfill is handled by dedupe.
      backfillEvents(
        pda,
        (evs) => absorb(evs, { toast: false }),
        abortController.signal
      )
        .catch((error) => {
          if (!abortController.signal.aborted) {
            logError("useGameEvents.backfill", error);
          }
        })
        .finally(() => {
          if (isMounted) {
            setIsBackfilling(false);
          }
        });

      await drainSubscription(notifications, absorb);
    };

    run().catch((error) => {
      // AbortError on unmount is expected; everything else is a real drop.
      // Same pattern as useGameSession / useTokenBalance.
      if (!abortController.signal.aborted) {
        logError("useGameEvents.subscription", error);
      }
    });

    return () => {
      isMounted = false;
      abortController.abort();
    };
  }, [gameId]);

  return {
    events,
    isBackfilling,
    clear: () => setEvents([]),
  };
}
