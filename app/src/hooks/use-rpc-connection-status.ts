/**
 * `useRpcConnectionStatus` — periodically ping the RPC and expose
 * connection state.
 *
 * **Scope (intentionally narrow):**
 *
 * Real WebSocket reconnection logic (re-subscribing dropped streams,
 * exponential backoff, fallback to polling) is genuinely hard to do
 * correctly with Kit's `accountNotifications` async-iterator API. This
 * hook does the simpler, observable thing: pings `getSlot` every
 * RPC_PING_INTERVAL_MS milliseconds and reports whether the call
 * succeeded.
 *
 * The existing per-account subscriptions (`useGameSession`,
 * `usePlayerState`, `useTokenBalance`) handle drops via React Query's
 * built-in `refetchOnReconnect` (the browser fires a `online` event
 * when network comes back, RQ refetches everything). What this hook
 * adds is a USER-VISIBLE indicator so the UI doesn't silently lie
 * about being live when the WebSocket is actually dead.
 *
 * If the RPC is unreachable for two consecutive pings, the status
 * flips to "disconnected". One success flips it back to "connected".
 *
 * Spec: docs/EXECUTION_PLAN.md Task 3.6.4.
 */

import { useEffect, useRef, useState } from "react";

import { logError } from "@/lib/logger";
import { rpc } from "@/lib/program";

const RPC_PING_INTERVAL_MS = 30_000;
const RPC_PING_TIMEOUT_MS = 5000;
const FAILURE_THRESHOLD = 2;

export type RpcConnectionStatus = "connecting" | "connected" | "disconnected";

interface UseRpcConnectionStatusResult {
  /** Slot at the most recent successful ping. Useful for diagnostics. */
  lastSlot: bigint | null;
  /** Wall-clock timestamp of the last successful ping (ms since epoch). */
  lastSuccessAt: number | null;
  status: RpcConnectionStatus;
}

/**
 * Race a promise against a timeout. Rejects with a timeout error if the
 * promise doesn't resolve before `timeoutMs`.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`RPC ping timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function useRpcConnectionStatus(): UseRpcConnectionStatusResult {
  const [status, setStatus] = useState<RpcConnectionStatus>("connecting");
  const [lastSlot, setLastSlot] = useState<bigint | null>(null);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  // The failure counter lives in a `useRef` rather than a `let` inside
  // the effect so it survives any future change to the effect's deps
  // array. With the previous `let` pattern, adding any dep would have
  // silently reset the counter on every dep change and the
  // "disconnected" state would never have flipped. Heavy-duty review
  // #10 finding #11.
  const consecutiveFailuresRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function ping() {
      try {
        const slot = await withTimeout(
          rpc.getSlot().send(),
          RPC_PING_TIMEOUT_MS
        );
        if (cancelled) {
          return;
        }
        consecutiveFailuresRef.current = 0;
        setLastSlot(slot);
        setLastSuccessAt(Date.now());
        setStatus("connected");
      } catch (error) {
        if (cancelled) {
          return;
        }
        consecutiveFailuresRef.current += 1;
        logError("useRpcConnectionStatus.ping", error);
        if (consecutiveFailuresRef.current >= FAILURE_THRESHOLD) {
          setStatus("disconnected");
        }
      }
    }

    // Fire one ping immediately so the user doesn't see "connecting…"
    // for 30 seconds at startup.
    ping();
    const interval = setInterval(ping, RPC_PING_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return { status, lastSlot, lastSuccessAt };
}
