/**
 * `useGameActions` — mutation handlers for the in-game player actions.
 *
 * Each action follows the same shape:
 *   1. Build a Kit `Instruction` via `@pushflip/client`'s instruction
 *      builders (which encode our hand-written byte layouts).
 *   2. Wrap the instruction in a Kit `TransactionMessage` with the
 *      connected wallet as the fee payer and a fresh blockhash lifetime.
 *   3. Hand off to `signAndSendKitMessage` (the wallet adapter ↔ Kit
 *      bridge in `@/lib/wallet-bridge`) which signs via the wallet
 *      adapter and sends + confirms via the Kit RPC client.
 *   4. On success: invalidate the GameSession + PlayerState caches so
 *      both hooks refetch and the UI immediately reflects the new state.
 *      Toast the result.
 *   5. On failure: toast the error message.
 *
 * Re-entry safety: each public action checks `mutation.isPending` and
 * rejects with a clear error if already in flight, so a double-click on
 * a button doesn't produce two on-chain transactions. The hook does NOT
 * rely on UI button-disable for correctness — that's a UX nicety on top.
 *
 * `hit` is included for API completeness but currently throws — wiring
 * the dealer service into the frontend is Task 3.6's job.
 */

import {
  deriveGamePda,
  derivePlayerPda,
  deriveVaultPda,
  getBurnScryInstruction,
  getBurnSecondChanceInstruction,
  getJoinRoundInstruction,
  getStayInstruction,
  MIN_STAKE,
  TOKEN_PROGRAM_ID,
} from "@pushflip/client";
import { fromLegacyPublicKey } from "@solana/compat";
import {
  type Address,
  appendTransactionMessageInstruction,
  createTransactionMessage,
  type Instruction,
  pipe,
  type Signature,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type TransactionSigner,
} from "@solana/kit";
import { useWallet } from "@solana/wallet-adapter-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";

import { GAME_ID, TOKEN_MINT } from "@/lib/constants";
import { rpc } from "@/lib/program";
import { signAndSendKitMessage } from "@/lib/wallet-bridge";

import { gameSessionQueryKey } from "./use-game-session";
import { playerStateQueryKey } from "./use-player-state";

/**
 * Default stake amount = the on-chain minimum. Imported from `@pushflip/client`
 * (which mirrors `program/src/utils/constants.rs::MIN_STAKE`) to keep one
 * source of truth across the workspace. Task 3.4.3's JoinGameDialog will
 * let users override this with any value `>= MIN_STAKE`.
 */
const DEFAULT_STAKE_AMOUNT = MIN_STAKE;

/**
 * Build a Kit `TransactionSigner` placeholder from the wallet's public key.
 *
 * `setTransactionMessageFeePayerSigner` requires a `TransactionSigner`,
 * but our actual signing happens in `signAndSendKitMessage` via the wallet
 * adapter. We only need the address for the fee-payer slot — the signer's
 * `signTransactions` callback never runs in our code path because we go
 * straight to the wallet bridge after `compileTransaction`. Verified by
 * reading `@solana/signers/dist/types/fee-payer-signer.d.ts`:
 * `setTransactionMessageFeePayerSigner` only stores the signer in the
 * message's `feePayer` field; it never invokes `signer.signTransactions()`.
 */
function makeFeePayerOnlySigner(address: Address): TransactionSigner {
  return {
    address,
    signTransactions: () => {
      throw new Error(
        "wallet-bridge: signTransactions called on placeholder signer; signing should go through the wallet adapter"
      );
    },
  };
}

/** Common transaction-message builder used by every action below. */
async function buildSingleInstructionMessage(
  feePayer: Address,
  ix: Instruction
) {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const feePayerSigner = makeFeePayerOnlySigner(feePayer);

  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayerSigner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstruction(ix, m)
  );
}

/**
 * Derive the player's associated token account for the game's mint.
 *
 * For Phase 3.2 we hardcode `TOKEN_MINT` from constants. Once multi-game
 * support lands (Task 3.6.x) the mint should be read from the GameSession
 * account instead.
 *
 * Uses the standard SPL Token ATA derivation; we don't have the helper
 * exported from `@pushflip/client` yet, so we inline it here.
 */
async function deriveAssociatedTokenAddress(owner: Address): Promise<Address> {
  // Lazy import keeps the @solana-program/token chunk out of the main
  // bundle for routes that don't need actions.
  const { findAssociatedTokenPda } = await import("@solana-program/token");
  const [ata] = await findAssociatedTokenPda({
    mint: TOKEN_MINT,
    owner,
    tokenProgram: TOKEN_PROGRAM_ID,
  });
  return ata;
}

interface UseGameActionsResult {
  burnScry: () => Promise<Signature>;
  burnSecondChance: () => Promise<Signature>;
  hit: () => Promise<Signature>;
  isPending: boolean;
  joinRound: (stakeAmount?: bigint) => Promise<Signature>;
  stay: () => Promise<Signature>;
}

/**
 * @param gameId Defaults to `GAME_ID` from constants. Phase 3.6 multi-game
 * support will pass per-component game ids; until then this defaults to the
 * single hardcoded game.
 */
export function useGameActions(gameId: bigint = GAME_ID): UseGameActionsResult {
  const { publicKey, signTransaction } = useWallet();
  const queryClient = useQueryClient();

  const invalidateGameAndPlayer = useCallback(() => {
    const playerBase58 = publicKey?.toBase58() ?? null;
    queryClient.invalidateQueries({ queryKey: gameSessionQueryKey(gameId) });
    queryClient.invalidateQueries({
      queryKey: playerStateQueryKey(gameId, playerBase58),
    });
  }, [gameId, publicKey, queryClient]);

  /**
   * Run a single-instruction action: build the message, sign + send via
   * the wallet bridge, toast the result on either success or failure,
   * invalidate caches on success.
   */
  const runAction = useCallback(
    async (
      label: string,
      buildIx: (player: Address) => Promise<Instruction>
    ): Promise<Signature> => {
      if (!(publicKey && signTransaction)) {
        throw new Error("Wallet not connected");
      }
      try {
        const player = fromLegacyPublicKey(publicKey);
        const ix = await buildIx(player);
        const message = await buildSingleInstructionMessage(player, ix);
        const signature = await signAndSendKitMessage(message, signTransaction);
        toast.success(`${label} confirmed`, { description: signature });
        invalidateGameAndPlayer();
        return signature;
      } catch (error) {
        const description =
          error instanceof Error ? error.message : String(error);
        toast.error(`${label} failed`, { description });
        throw error;
      }
    },
    [publicKey, signTransaction, invalidateGameAndPlayer]
  );

  // --- Mutations (one per action so React Query exposes individual loading state) ---

  const joinRoundMutation = useMutation({
    mutationFn: (stakeAmount: bigint = DEFAULT_STAKE_AMOUNT) => {
      // Fail fast on negative or zero stake. `setBigUint64` silently wraps
      // negative bigints to huge positives, which the on-chain program
      // would reject (after burning the user's gas) — better to refuse
      // here with a clear error before round-tripping to the chain.
      if (stakeAmount < MIN_STAKE) {
        return Promise.reject(
          new Error(
            `Stake amount must be at least ${MIN_STAKE} base units (100 $FLIP)`
          )
        );
      }
      return runAction("Join round", async (player) => {
        const [gameSession] = await deriveGamePda(gameId);
        const [playerState, bump] = await derivePlayerPda(gameId, player);
        const [vault] = await deriveVaultPda(gameSession);
        const playerTokenAccount = await deriveAssociatedTokenAddress(player);

        return getJoinRoundInstruction(
          {
            gameSession,
            player,
            playerState,
            playerTokenAccount,
            vault,
          },
          { bump, stakeAmount }
        );
      });
    },
  });

  const stayMutation = useMutation({
    mutationFn: () =>
      runAction("Stay", async (player) => {
        const [gameSession] = await deriveGamePda(gameId);
        const [playerState] = await derivePlayerPda(gameId, player);
        return getStayInstruction({ gameSession, player, playerState });
      }),
  });

  const burnSecondChanceMutation = useMutation({
    mutationFn: () =>
      runAction("Burn for second chance", async (player) => {
        const [gameSession] = await deriveGamePda(gameId);
        const [playerState] = await derivePlayerPda(gameId, player);
        const playerTokenAccount = await deriveAssociatedTokenAddress(player);

        return getBurnSecondChanceInstruction({
          gameSession,
          player,
          playerState,
          playerTokenAccount,
          tokenMint: TOKEN_MINT,
        });
      }),
  });

  const burnScryMutation = useMutation({
    mutationFn: () =>
      runAction("Burn for scry", async (player) => {
        const [gameSession] = await deriveGamePda(gameId);
        const [playerState] = await derivePlayerPda(gameId, player);
        const playerTokenAccount = await deriveAssociatedTokenAddress(player);

        return getBurnScryInstruction({
          gameSession,
          player,
          playerState,
          playerTokenAccount,
          tokenMint: TOKEN_MINT,
        });
      }),
  });

  const hitMutation = useMutation({
    mutationFn: (): Promise<Signature> => {
      // hit() needs a card revealed by the dealer service + a Merkle proof
      // for that card's position in the committed deck. Wiring the dealer
      // HTTP API into the frontend is Task 3.6.3.
      return Promise.reject(
        new Error(
          "hit() is not yet implemented — wire up the dealer service in Task 3.6.3"
        )
      );
    },
  });

  /**
   * Wrap each public action with a re-entry guard. If the same mutation
   * is already in flight, reject the second call instead of silently
   * starting a parallel one. This prevents double-click → double-spend
   * regardless of whether the UI disables its buttons. The error message
   * is descriptive so callers can show a clear toast or no-op.
   */
  return {
    joinRound: (stakeAmount?: bigint) =>
      joinRoundMutation.isPending
        ? Promise.reject(new Error("Join round already in progress"))
        : joinRoundMutation.mutateAsync(stakeAmount ?? DEFAULT_STAKE_AMOUNT),
    stay: () =>
      stayMutation.isPending
        ? Promise.reject(new Error("Stay already in progress"))
        : stayMutation.mutateAsync(),
    burnSecondChance: () =>
      burnSecondChanceMutation.isPending
        ? Promise.reject(new Error("Second-chance burn already in progress"))
        : burnSecondChanceMutation.mutateAsync(),
    burnScry: () =>
      burnScryMutation.isPending
        ? Promise.reject(new Error("Scry burn already in progress"))
        : burnScryMutation.mutateAsync(),
    hit: () =>
      hitMutation.isPending
        ? Promise.reject(new Error("Hit already in progress"))
        : hitMutation.mutateAsync(),
    isPending:
      joinRoundMutation.isPending ||
      stayMutation.isPending ||
      burnSecondChanceMutation.isPending ||
      burnScryMutation.isPending ||
      hitMutation.isPending,
  };
}
