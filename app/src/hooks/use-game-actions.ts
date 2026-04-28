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
 *   4. Toast the outcome (success or structured error via
 *      `TransactionSimulationError` + `formatTxErrorDescription`).
 *   5. Always invalidate the GameSession + PlayerState caches in a
 *      `finally` block — **including on failure**. A send-stage
 *      failure (blockhash expiry, confirmation timeout, RPC drop)
 *      leaves the on-chain state in an unknown condition, so the
 *      client cache cannot be trusted for a retry. Refreshing
 *      regardless of outcome is the prophylactic fix — it covers
 *      actions that are NOT program-level idempotent. See the 12th
 *      heavy-duty review, Finding M1.
 *
 * Re-entry safety: each public action checks `mutation.isPending` and
 * rejects with a clear error if already in flight, so a double-click on
 * a button doesn't produce two on-chain transactions. The hook does NOT
 * rely on UI button-disable for correctness — that's a UX nicety on top.
 *
 * **Verbose logging**: every action flows through `debugGroupStart(label)`
 * + step-by-step `debugAction()` calls (see `@/lib/debug-log`). Gated on
 * `import.meta.env.DEV`, so production bundles emit nothing. Developers
 * can disable at runtime via `window.__PUSHFLIP_DEBUG__ = false`.
 *
 * `hit` is included for API completeness but currently throws — wiring
 * the dealer service into the frontend is Task 3.6's job.
 */

import {
  decodeGameSession,
  deriveGamePda,
  derivePlayerPda,
  deriveVaultPda,
  getBurnScryInstruction,
  getBurnSecondChanceInstruction,
  getHitInstruction,
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
  parseBase64RpcAccount,
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
import { debugAction, debugGroupStart } from "@/lib/debug-log";
import { rpc } from "@/lib/program";
import {
  formatTxErrorDescription,
  TransactionSimulationError,
} from "@/lib/tx-error";
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
 * Resolve the dealer service base URL. Same shape + production guard
 * as `resolveFaucetUrl` / `resolveNicknameBaseUrl`: dev defaults to
 * `http://localhost:3002`, production builds REQUIRE
 * `VITE_DEALER_URL=/api/dealer` (or similar same-origin path) and
 * throw at module load if missing. Cross-origin URLs in production
 * are refused — same exfiltration-class defense as the faucet
 * resolver.
 *
 * Pre-Mainnet 5.2 / Phase 4. The path appended to this base for the
 * card-reveal endpoint is `/reveal/:gameId/:roundNumber/:leafIndex`,
 * which routes (after nginx strips `/api/dealer/`) to the dealer
 * service's `GET /reveal/...` handler in `dealer/src/service.ts`.
 */
function resolveDealerUrl(): string {
  const fromEnv = import.meta.env.VITE_DEALER_URL as string | undefined;
  if (fromEnv && fromEnv.length > 0) {
    if (!(import.meta.env.DEV || fromEnv.startsWith("/"))) {
      throw new Error(
        `VITE_DEALER_URL must be a same-origin relative path starting with "/" in production builds. Got: ${fromEnv}`
      );
    }
    return fromEnv;
  }
  if (import.meta.env.DEV) {
    return "http://localhost:3002";
  }
  throw new Error(
    "VITE_DEALER_URL is required in production builds. Set it at build time to the deployed dealer service URL (e.g. /api/dealer)."
  );
}

const DEALER_BASE_URL = resolveDealerUrl();

// 32-byte hex sibling hash. Hoisted to module scope per biome's
// `useTopLevelRegex` — `fetchDealerReveal` validates 7 of these per
// hit, so re-compiling the regex inside a `.map` callback would
// recompile 7 times per action.
const HEX_SIBLING_HASH = /^[0-9a-f]+$/;

interface DealerReveal {
  card: { cardType: number; value: number; suit: number };
  leafIndex: number;
  /** 7 sibling hashes, 32 bytes each (decoded from hex). */
  merkleProof: Uint8Array[];
}

/**
 * Fetch the next card + Merkle proof from the dealer service for the
 * given (gameId, roundNumber, leafIndex). The on-chain hit instruction
 * validates `leafIndex` matches the GameSession's `draw_counter`; we
 * trust the dealer to be in sync since both read the same on-chain
 * state.
 *
 * Throws on network error, non-200 response, or malformed payload.
 * The 5-second timeout (AbortSignal.timeout) is generous: a healthy
 * dealer responds in ~5ms (purely in-memory tree lookup, no I/O
 * beyond the HTTP overhead), so anything > 5s indicates a real
 * problem the user should know about.
 */
async function fetchDealerReveal(
  gameId: bigint,
  roundNumber: bigint,
  leafIndex: number
): Promise<DealerReveal> {
  const url = `${DEALER_BASE_URL}/reveal/${gameId}/${roundNumber}/${leafIndex}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Dealer reveal failed (HTTP ${res.status}): ${body}`);
  }
  const body = (await res.json()) as {
    leaf_index?: number;
    card?: { card_type?: number; value?: number; suit?: number };
    merkle_proof?: string[];
  };
  if (
    typeof body.leaf_index !== "number" ||
    !body.card ||
    typeof body.card.card_type !== "number" ||
    typeof body.card.value !== "number" ||
    typeof body.card.suit !== "number" ||
    !Array.isArray(body.merkle_proof) ||
    body.merkle_proof.length !== 7
  ) {
    throw new Error(
      `Dealer reveal malformed: expected {leaf_index, card, merkle_proof[7]}, got ${JSON.stringify(body).slice(0, 200)}`
    );
  }
  // Decode hex → Uint8Array per sibling. Each hash is 32 bytes = 64 hex chars.
  const merkleProof: Uint8Array[] = body.merkle_proof.map((hex, i) => {
    if (
      typeof hex !== "string" ||
      hex.length !== 64 ||
      !HEX_SIBLING_HASH.test(hex)
    ) {
      throw new Error(
        `Dealer reveal merkle_proof[${i}] is not a 64-char lowercase hex string`
      );
    }
    const bytes = new Uint8Array(32);
    for (let j = 0; j < 32; j++) {
      bytes[j] = Number.parseInt(hex.slice(j * 2, j * 2 + 2), 16);
    }
    return bytes;
  });
  return {
    leafIndex: body.leaf_index,
    card: {
      cardType: body.card.card_type,
      value: body.card.value,
      suit: body.card.suit,
    },
    merkleProof,
  };
}

/**
 * Reduce an action failure to the single-line description that the
 * sonner toast expects. Extracted out of `runAction` so biome's
 * `noNestedTernary` stays happy AND so the fallthrough logic is
 * testable in isolation if we ever add unit tests here.
 */
function toActionErrorDescription(error: unknown): string {
  if (error instanceof TransactionSimulationError) {
    return formatTxErrorDescription(error);
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

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
  // `publicKey` is an object reference whose identity changes every
  // render of the wallet-adapter context. Memoize once into a stable
  // base58 string for use in dep arrays — Lesson #40 / Pre-Mainnet 5.0.8.
  const publicKeyBase58 = publicKey?.toBase58() ?? null;
  const queryClient = useQueryClient();

  const invalidateGameAndPlayer = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: gameSessionQueryKey(gameId) });
    queryClient.invalidateQueries({
      queryKey: playerStateQueryKey(gameId, publicKeyBase58),
    });
  }, [gameId, publicKeyBase58, queryClient]);

  /**
   * Run a single-instruction action: build the message, sign + send via
   * the wallet bridge, toast the result on either success or failure,
   * invalidate caches on success.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: depend on `publicKeyBase58` (stable string) instead of `publicKey` (object identity changes every render of the wallet adapter context). Lesson #40 / Pre-Mainnet 5.0.8 — the local plugin `biome-plugins/no-publickey-in-hook-deps.grit` is the authoritative rule here.
  const runAction = useCallback(
    async (
      label: string,
      buildIx: (player: Address) => Promise<Instruction>
    ): Promise<Signature> => {
      const closeGroup = debugGroupStart(label);
      if (!(publicKey && signTransaction)) {
        debugAction(`${label}: aborted — wallet not connected`);
        closeGroup();
        throw new Error("Wallet not connected");
      }
      try {
        debugAction(`${label}: start`, {
          walletAdapterPublicKey: publicKey.toBase58(),
        });
        const player = fromLegacyPublicKey(publicKey);
        debugAction(`${label}: player kit address`, { player });
        const ix = await buildIx(player);
        debugAction(`${label}: built instruction`, {
          programAddress: ix.programAddress,
          accountCount: ix.accounts?.length ?? 0,
          dataLength: ix.data?.length,
        });
        const message = await buildSingleInstructionMessage(player, ix);
        debugAction(`${label}: built transaction message`, {
          feePayer: message.feePayer.address,
          blockhash: message.lifetimeConstraint.blockhash,
          lastValidBlockHeight:
            message.lifetimeConstraint.lastValidBlockHeight.toString(),
        });
        const signature = await signAndSendKitMessage(message, signTransaction);
        debugAction(`${label}: confirmed`, { signature });
        toast.success(`${label} confirmed`, { description: signature });
        return signature;
      } catch (error) {
        // `TransactionSimulationError` has structured fields (kind,
        // program logs, human hint) that make for much better toast
        // copy than the raw Error.message. Fall through to the
        // generic stringify for everything else.
        debugAction(`${label}: failed`, {
          kind:
            error instanceof TransactionSimulationError
              ? error.kind
              : "unknown",
          error,
        });
        const description = toActionErrorDescription(error);
        toast.error(`${label} failed`, { description });
        throw error;
      } finally {
        // Invalidate in `finally` — not just on success. A send-stage
        // failure (blockhash expiry, confirmation timeout, RPC drop)
        // leaves the on-chain state in an unknown condition: the
        // broadcast may or may not have landed. The client cache is
        // no longer trustworthy, so we refresh it regardless of
        // outcome. This is prophylactic for actions that are NOT
        // idempotent by the on-chain program's own checks — `joinRound`
        // happens to be safe via `PlayerAlreadyJoined`, but future
        // actions (stay / hit / burn) may not share that property,
        // and this helper is the single enforcement point.
        invalidateGameAndPlayer();
        closeGroup();
      }
    },
    // Track the wallet by its base58 identity (stable string) — the
    // `publicKey` object reference changes every render of the wallet
    // adapter context, which would invalidate this callback every render
    // and re-create every downstream useCallback that depends on it.
    // Lesson #40 / Pre-Mainnet 5.0.8.
    [publicKeyBase58, signTransaction, invalidateGameAndPlayer]
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
    mutationFn: () =>
      runAction("Hit", async (player) => {
        // Read the on-chain GameSession to learn the current
        // round_number + draw_counter. The dealer's reveal endpoint
        // will only return a valid card if these match its committed
        // round + next leaf index. We could trust the dealer's
        // internal counters, but reading the chain first means a
        // dealer that's out of sync (crashed + restarted, missed a
        // commit, etc.) gets caught here — before we burn the user's
        // gas on a hit instruction the program would reject.
        const [gameSession] = await deriveGamePda(gameId);
        const [playerState] = await derivePlayerPda(gameId, player);
        const accountInfo = await rpc
          .getAccountInfo(gameSession, { encoding: "base64" })
          .send();
        const parsed = parseBase64RpcAccount(gameSession, accountInfo.value);
        if (!parsed.exists) {
          throw new Error(`GameSession at ${gameSession} does not exist`);
        }
        const gs = decodeGameSession(parsed.data);
        if (!gs.roundActive) {
          throw new Error(
            "No active round — dealer hasn't committed a deck yet"
          );
        }

        // Pre-Mainnet 5.2 / Decision #4: fetch the next card + Merkle
        // proof from the dealer service. The dealer is the single
        // source of truth for the shuffled deck; the on-chain program
        // verifies the proof against the committed Merkle root.
        const reveal = await fetchDealerReveal(
          gameId,
          gs.roundNumber,
          gs.drawCounter
        );

        return getHitInstruction(
          { gameSession, player, playerState },
          {
            cardValue: reveal.card.value,
            cardType: reveal.card.cardType,
            cardSuit: reveal.card.suit,
            merkleProof: reveal.merkleProof,
            leafIndex: reveal.leafIndex,
          }
        );
      }),
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
