/**
 * `useTokenBalance` — fetch + subscribe to the connected wallet's $FLIP
 * associated token account balance.
 *
 * Same fetch-then-subscribe pattern as `useGameSession` and
 * `usePlayerState`: a React Query reads the ATA once, then a sibling
 * effect opens an `accountNotifications` subscription on the Kit RPC
 * subscriptions client and pushes balance updates into the cache.
 *
 * Returns the balance in **base units** (u64 scaled by FLIP_DECIMALS).
 * Components that want to show "100 $FLIP" should divide by
 * `10n ** BigInt(FLIP_DECIMALS)` themselves — kept as base units here
 * so the math doesn't lose precision.
 *
 * Returns `null` data if:
 *   - the wallet is disconnected
 *   - the connected wallet has no ATA for `TOKEN_MINT` yet (the user
 *     has never received any test $FLIP)
 *
 * Spec: docs/EXECUTION_PLAN.md Task 3.4.2.
 */

import { TOKEN_PROGRAM_ID } from "@pushflip/client";
import { fromLegacyPublicKey } from "@solana/compat";
import { type Address, parseBase64RpcAccount } from "@solana/kit";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  type UseQueryResult,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { TOKEN_MINT } from "@/lib/constants";
import { logError } from "@/lib/logger";
import { rpc, rpcSubscriptions } from "@/lib/program";

/**
 * Cache key for the React Query cache. Exported for invalidation by
 * mutations that change the player's $FLIP balance (joinRound stakes,
 * burnSecondChance and burnScry burns, end-of-round payouts).
 */
export function tokenBalanceQueryKey(
  mint: Address,
  walletBase58: string | null
): readonly [string, string, string] {
  return [
    "tokenBalance",
    mint.toString(),
    walletBase58 ?? "disconnected",
  ] as const;
}

interface TokenBalanceQueryData {
  /** ATA address — derived deterministically from (mint, owner). */
  ata: Address;
  /** Balance in base units. `null` if the ATA does not exist on chain yet. */
  balance: bigint | null;
}

/**
 * Decode the `amount` field from a 165-byte SPL Token account.
 *
 * SPL Token v1 account layout:
 *   [0..32]   mint           (32 bytes)
 *   [32..64]  owner          (32 bytes)
 *   [64..72]  amount         (u64 LE)  ← we want this
 *   [72..76]  delegate option
 *   [76..108] delegate (if option=1)
 *   ... (state, isNative option, isNative, delegated_amount, close_authority)
 *
 * Total size: 165 bytes. We only need the amount, so a single
 * DataView read at offset 64 is enough — no full deserializer required.
 */
function decodeTokenAccountAmount(data: Uint8Array): bigint {
  if (data.length < 72) {
    throw new Error(
      `Token account data too short: ${data.length} bytes (need >= 72)`
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(64, true);
}

/**
 * Subscribe to the connected wallet's $FLIP ATA balance.
 *
 * Returns the standard React Query result so callers use
 * `query.data?.balance` and `query.isLoading` directly.
 */
export function useTokenBalance(
  mint: Address = TOKEN_MINT
): UseQueryResult<TokenBalanceQueryData, Error> {
  const queryClient = useQueryClient();
  const { publicKey } = useWallet();

  // Mirror the wallet via its base58 string for stable cache-key identity
  // — same pattern as usePlayerState. Keeps the WebSocket subscription
  // from re-firing every render if the wallet adapter ever returns a
  // fresh PublicKey object reference.
  const publicKeyBase58 = publicKey?.toBase58() ?? null;

  const queryKey = useMemo(
    () => tokenBalanceQueryKey(mint, publicKeyBase58),
    [mint, publicKeyBase58]
  );

  const query = useQuery<TokenBalanceQueryData, Error>({
    queryKey,
    enabled: publicKey !== null,
    queryFn: async () => {
      if (!publicKey) {
        throw new Error("useTokenBalance: wallet not connected");
      }
      const owner = fromLegacyPublicKey(publicKey);
      // Lazy import keeps the @solana-program/token chunk out of the
      // initial bundle. Same pattern as useGameActions.
      const { findAssociatedTokenPda } = await import("@solana-program/token");
      const [ata] = await findAssociatedTokenPda({
        mint,
        owner,
        tokenProgram: TOKEN_PROGRAM_ID,
      });
      const account = await rpc
        .getAccountInfo(ata, { encoding: "base64" })
        .send();
      const parsed = parseBase64RpcAccount(ata, account.value);
      if (!parsed.exists) {
        return { ata, balance: null };
      }
      return {
        ata,
        balance: decodeTokenAccountAmount(new Uint8Array(parsed.data)),
      };
    },
  });

  const ata = query.data?.ata;

  useEffect(() => {
    if (!ata) {
      return;
    }
    const abortController = new AbortController();

    (async () => {
      try {
        const notifications = await rpcSubscriptions
          .accountNotifications(ata, {
            commitment: "confirmed",
            encoding: "base64",
          })
          .subscribe({ abortSignal: abortController.signal });

        for await (const notification of notifications) {
          // accountNotifications always emits a non-null `value` per
          // Kit's type contract, so parseBase64RpcAccount returns
          // EncodedAccount (not MaybeEncodedAccount) — no .exists
          // check needed here. Same pattern as use-game-session.ts.
          const parsed = parseBase64RpcAccount(ata, notification.value);
          const next: TokenBalanceQueryData = {
            ata,
            balance: decodeTokenAccountAmount(new Uint8Array(parsed.data)),
          };
          queryClient.setQueryData(queryKey, next);
        }
      } catch (error) {
        // AbortError on unmount is expected; everything else is a real drop.
        if (!abortController.signal.aborted) {
          logError("useTokenBalance.subscription", error);
        }
      }
    })();

    return () => {
      abortController.abort();
    };
  }, [ata, queryKey, queryClient]);

  return query;
}
