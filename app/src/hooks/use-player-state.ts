/**
 * `usePlayerState` — fetch + subscribe to the PlayerState PDA for the
 * connected wallet in a given game.
 *
 * Same pattern as `useGameSession`: React Query holds the cache, a sibling
 * effect opens an `accountNotifications` subscription and pushes updates
 * via `queryClient.setQueryData`.
 *
 * Wallet bridge note: the PDA is derived from the wallet's address, but
 * `useWallet()` from `@solana/wallet-adapter-react` returns a web3.js v1
 * `PublicKey`. We translate to a Kit `Address` once via `@solana/compat`'s
 * `fromLegacyPublicKey` and feed the result into `derivePlayerPda`. This is
 * the first place in the app where the wallet ↔ Kit bridge actually fires.
 */

import {
  decodePlayerState,
  derivePlayerPda,
  type PlayerState,
} from "@pushflip/client";
import { fromLegacyPublicKey } from "@solana/compat";
import { parseBase64RpcAccount } from "@solana/kit";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  type UseQueryResult,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { logError } from "@/lib/logger";
import { rpc, rpcSubscriptions } from "@/lib/program";

/**
 * Cache key for the React Query cache. Exported for invalidation in mutations.
 *
 * Takes the player's base58 string (NOT a Kit `Address` brand) so the key is
 * stable across renders even if the wallet adapter ever returns a fresh
 * `PublicKey` object reference. The hook below mirrors the wallet via
 * `publicKey?.toBase58()` for the same stability reason.
 */
export function playerStateQueryKey(
  gameId: bigint,
  playerBase58: string | null
): readonly [string, string, string] {
  return [
    "playerState",
    gameId.toString(),
    playerBase58 ?? "disconnected",
  ] as const;
}

interface PlayerStateQueryData {
  /** `null` if the player has not joined this game yet. */
  data: PlayerState | null;
  pda: Awaited<ReturnType<typeof derivePlayerPda>>[0];
}

/**
 * Subscribe to the PlayerState PDA for the connected wallet + given game_id.
 *
 * Returns `null` data if the wallet is disconnected, or if the player has
 * not joined the game (the PDA exists in address-space but the account has
 * never been initialized).
 */
export function usePlayerState(
  gameId: bigint
): UseQueryResult<PlayerStateQueryData, Error> {
  const queryClient = useQueryClient();
  const { publicKey } = useWallet();

  // Mirror the wallet via its base58 string — a primitive with naturally
  // stable equality semantics. We don't depend on `useWallet()` returning
  // the same `PublicKey` object reference across renders, which is an
  // implicit (undocumented) contract that future wallet adapter versions
  // could break. The Kit `Address` translation happens lazily inside
  // queryFn, where it only runs when React Query actually fetches.
  const publicKeyBase58 = publicKey?.toBase58() ?? null;

  // Memoized for the same reason as gameSessionQueryKey: a fresh tuple
  // each render would re-fire the subscription effect every parent render.
  const queryKey = useMemo(
    () => playerStateQueryKey(gameId, publicKeyBase58),
    [gameId, publicKeyBase58]
  );

  const query = useQuery<PlayerStateQueryData, Error>({
    queryKey,
    enabled: publicKey !== null,
    queryFn: async () => {
      if (!publicKey) {
        // Defensive: `enabled` should prevent this, but TS doesn't know.
        throw new Error("usePlayerState: wallet not connected");
      }
      const playerAddress = fromLegacyPublicKey(publicKey);
      const [pda] = await derivePlayerPda(gameId, playerAddress);
      const account = await rpc
        .getAccountInfo(pda, { encoding: "base64" })
        .send();
      const parsed = parseBase64RpcAccount(pda, account.value);
      if (!parsed.exists) {
        return { pda, data: null };
      }
      return { pda, data: decodePlayerState(new Uint8Array(parsed.data)) };
    },
  });

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

        for await (const notification of notifications) {
          const parsed = parseBase64RpcAccount(pda, notification.value);
          const next: PlayerStateQueryData = {
            pda,
            data: decodePlayerState(new Uint8Array(parsed.data)),
          };
          queryClient.setQueryData(queryKey, next);
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          logError("usePlayerState.subscription", error);
        }
      }
    })();

    return () => {
      abortController.abort();
    };
  }, [pda, queryKey, queryClient]);

  return query;
}
