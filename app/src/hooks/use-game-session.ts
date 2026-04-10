/**
 * `useGameSession` — fetch + subscribe to a GameSession PDA.
 *
 * The first React Query reads the account once via `rpc.getAccountInfo`,
 * then a sibling effect opens an `accountNotifications` subscription on the
 * Kit RPC subscriptions client and pushes updates into the React Query cache
 * via `queryClient.setQueryData`. Components consume the cached value via
 * the standard `useQuery` return shape.
 *
 * Pattern intentionally minimal so it can be copied for `usePlayerState`,
 * `useBountyBoard`, etc. — anywhere we need "fetch one program-owned account
 * + subscribe to its updates."
 */

import {
  decodeGameSession,
  deriveGamePda,
  type GameSession,
} from "@pushflip/client";
import { parseBase64RpcAccount } from "@solana/kit";
import {
  type UseQueryResult,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { logError } from "@/lib/logger";
import { rpc, rpcSubscriptions } from "@/lib/program";

/** Cache key for the React Query cache. Exported for invalidation in mutations. */
export function gameSessionQueryKey(gameId: bigint): readonly [string, string] {
  return ["gameSession", gameId.toString()] as const;
}

interface GameSessionQueryData {
  /** `null` if the account does not exist on-chain yet. */
  data: GameSession | null;
  pda: Awaited<ReturnType<typeof deriveGamePda>>[0];
}

/**
 * Subscribe to a single GameSession by `game_id`.
 *
 * Returns the standard React Query result object so callers can use
 * `query.data?.data`, `query.isLoading`, `query.error`, etc.
 */
export function useGameSession(
  gameId: bigint
): UseQueryResult<GameSessionQueryData, Error> {
  const queryClient = useQueryClient();
  // Memoized so the useEffect dep array sees a stable reference across
  // re-renders. Without this, every parent re-render would re-fire the
  // subscription effect (gameSessionQueryKey returns a fresh tuple each
  // call) and thrash the WebSocket connection.
  const queryKey = useMemo(() => gameSessionQueryKey(gameId), [gameId]);

  const query = useQuery<GameSessionQueryData, Error>({
    queryKey,
    queryFn: async () => {
      const [pda] = await deriveGamePda(gameId);
      const account = await rpc
        .getAccountInfo(pda, { encoding: "base64" })
        .send();
      const parsed = parseBase64RpcAccount(pda, account.value);
      if (!parsed.exists) {
        return { pda, data: null };
      }
      // EncodedAccount.data is ReadonlyUint8Array; copy into a mutable
      // Uint8Array for the decoder. Cheap (one allocation per fetch).
      return { pda, data: decodeGameSession(new Uint8Array(parsed.data)) };
    },
  });

  // The PDA is stable for a given game_id, so we can grab it from the query
  // result and start the subscription as soon as the first fetch resolves.
  // The subscription's job from then on is to keep the cache fresh.
  const pda = query.data?.pda;

  useEffect(() => {
    if (!pda) {
      return;
    }

    const abortController = new AbortController();

    (async () => {
      try {
        const notifications = await rpcSubscriptions
          .accountNotifications(pda, {
            commitment: "confirmed",
            encoding: "base64",
          })
          .subscribe({ abortSignal: abortController.signal });

        // accountNotifications always emits a non-null `value` per Kit's
        // type contract, so parseBase64RpcAccount returns EncodedAccount
        // (not MaybeEncodedAccount) — no .exists check needed here.
        for await (const notification of notifications) {
          const parsed = parseBase64RpcAccount(pda, notification.value);
          const next: GameSessionQueryData = {
            pda,
            data: decodeGameSession(new Uint8Array(parsed.data)),
          };
          queryClient.setQueryData(queryKey, next);
        }
      } catch (error) {
        // AbortError on unmount is expected; everything else is a real drop.
        if (!abortController.signal.aborted) {
          logError("useGameSession.subscription", error);
        }
      }
    })();

    return () => {
      abortController.abort();
    };
  }, [pda, queryKey, queryClient]);

  return query;
}
