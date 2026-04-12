/**
 * GameBoard — top-level container for a single game.
 *
 * Wires together the read hooks (`useGameSession`, `usePlayerState`),
 * the action hook (`useGameActions`), and the four presentational
 * children: PotDisplay, TurnIndicator, PlayerHand, ActionButtons.
 *
 * Replaces the Phase 3.2 verification surface (`<GameStatusPanel>`)
 * and the Task 3.3.1 visual smoke test (`<CardShowcase>`).
 *
 * State derivation lives here so the children stay dumb. The rules:
 * - canHit / canStay: round is active AND it's the connected wallet's
 *   turn AND the player is not busted/stayed.
 * - canSecondChance: the player has busted AND has not used their
 *   single second-chance burn this game.
 * - canScry: same gating as Hit, plus has not used their single scry
 *   burn this game.
 * - "isMyTurn": the active turn-order slot points at the connected
 *   wallet's pubkey (compared via base58 strings).
 *
 * Hit() is currently stubbed in `useGameActions` (waiting on Task 3.6.3
 * to wire the dealer service); the button still respects `canHit` so
 * it'll Just Work once the dealer is wired in.
 *
 * Spec: docs/EXECUTION_PLAN.md Task 3.3.4.
 */

import {
  activeTurnOrder,
  type GameSession,
  InactiveReason,
} from "@pushflip/client";
import type { Address } from "@solana/kit";
import { useWallet } from "@solana/wallet-adapter-react";

import { FlipAdvisor } from "@/components/advisor/flip-advisor";
import { ActionButtons } from "@/components/game/action-buttons";
import { EventFeed } from "@/components/game/event-feed";
import { JoinGameDialog } from "@/components/game/join-game-dialog";
import { PlayerHand } from "@/components/game/player-hand";
import { PotDisplay } from "@/components/game/pot-display";
import { TurnIndicator } from "@/components/game/turn-indicator";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useGameSession } from "@/hooks/use-game-session";
import { usePlayerState } from "@/hooks/use-player-state";
import { useScryResult } from "@/hooks/use-scry-result";
import { GAME_ID } from "@/lib/constants";

function shortAddress(addr: Address): string {
  const s = addr.toString();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

interface ActiveTurnInfo {
  /** The address whose turn it is right now, or null if no round is active. */
  activePlayer: Address | null;
  /** True if `activePlayer` matches the connected wallet's base58. */
  isMyTurn: boolean;
}

/**
 * Resolve which player should be acting right now.
 *
 * Returns `null` activePlayer if:
 * - the round is not active
 * - the GameSession's currentTurnIndex points outside the populated
 *   turn order (defensive — should never happen on a well-formed account)
 */
function resolveActiveTurn(
  game: GameSession,
  walletBase58: string | null
): ActiveTurnInfo {
  if (!game.roundActive) {
    return { activePlayer: null, isMyTurn: false };
  }
  const order = activeTurnOrder(game);
  const active = order[game.currentTurnIndex] ?? null;
  if (!active) {
    return { activePlayer: null, isMyTurn: false };
  }
  return {
    activePlayer: active,
    isMyTurn: walletBase58 !== null && active.toString() === walletBase58,
  };
}

export function GameBoard() {
  const { publicKey } = useWallet();
  const walletBase58 = publicKey?.toBase58() ?? null;

  const gameQuery = useGameSession(GAME_ID);
  const playerQuery = usePlayerState(GAME_ID);

  // --- Loading + error gating ---
  if (gameQuery.isLoading) {
    return (
      <BoardShell>
        <BoardSkeleton />
      </BoardShell>
    );
  }
  if (gameQuery.isError) {
    return (
      <BoardShell>
        <div className="space-y-3">
          <p className="font-semibold text-destructive text-sm">
            Failed to load game
          </p>
          <p className="break-all rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive text-xs">
            {gameQuery.error.message}
          </p>
          {/* `disabled={isFetching}` covers the click-spam case: React
              Query dedupes concurrent requests internally, but the
              button should also visually reflect the in-flight state
              so the user knows the retry is running. */}
          <Button
            disabled={gameQuery.isFetching}
            onClick={() => gameQuery.refetch()}
            size="sm"
            variant="secondary"
          >
            {gameQuery.isFetching ? "Retrying…" : "Retry"}
          </Button>
        </div>
      </BoardShell>
    );
  }
  const game = gameQuery.data?.data ?? null;
  if (!game) {
    return (
      <BoardShell>
        <p className="text-muted-foreground">
          No GameSession at PDA{" "}
          <span className="font-mono text-xs">
            {gameQuery.data?.pda ?? "(deriving…)"}
          </span>
          . Initialize <code>game_id={GAME_ID.toString()}</code> on devnet to
          populate this board (run{" "}
          <code className="text-xs">
            pnpm --filter @pushflip/scripts init-game
          </code>
          ).
        </p>
      </BoardShell>
    );
  }

  // --- State derivation ---
  const player = playerQuery.data?.data ?? null;
  const playerHasJoined = player !== null;
  const isPlayerBust = player?.inactiveReason === InactiveReason.Bust;
  const isPlayerStayed = player?.inactiveReason === InactiveReason.Stayed;
  const isPlayerActive = player?.isActive ?? false;

  const { activePlayer, isMyTurn } = resolveActiveTurn(game, walletBase58);

  const canHit = isMyTurn && isPlayerActive && !isPlayerBust && !isPlayerStayed;
  const canStay = canHit;
  const canSecondChance =
    isPlayerBust && player !== null && !player.hasUsedSecondChance;
  const canScry = canHit && player !== null && !player.hasUsedScry;

  const order = activeTurnOrder(game);

  return (
    <BoardShell>
      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <div className="space-y-3">
          <h2 className="font-semibold text-lg">
            Game {game.gameId.toString()}{" "}
            <span className="ml-2 text-muted-foreground text-xs">
              Round {game.roundNumber.toString()}
            </span>
          </h2>
          <TurnIndicator activePlayer={activePlayer} isMe={isMyTurn} />
        </div>
        <PotDisplay amount={game.potAmount} />
      </div>

      {/* All players' hands */}
      <div className="mt-4 space-y-3">
        {order.length === 0 ? (
          <div className="rounded border border-border/50 border-dashed p-4 text-center text-muted-foreground text-sm">
            No players have joined yet. Connect your wallet and join the game
            below.
          </div>
        ) : (
          order.map((addr) => {
            const isMe =
              walletBase58 !== null && addr.toString() === walletBase58;
            const handForThisPlayer = isMe && player ? player.hand : [];
            const scoreForThisPlayer = isMe && player ? player.score : 0n;
            const bustForThisPlayer =
              isMe && player
                ? player.inactiveReason === InactiveReason.Bust
                : false;
            const isCurrentTurnForThisPlayer =
              activePlayer !== null &&
              addr.toString() === activePlayer.toString();
            return (
              <PlayerHand
                bust={bustForThisPlayer}
                hand={handForThisPlayer}
                isCurrentTurn={isCurrentTurnForThisPlayer}
                key={addr.toString()}
                label={
                  isMe ? `${shortAddress(addr)} (you)` : shortAddress(addr)
                }
                labelTitle={addr.toString()}
                score={scoreForThisPlayer}
              />
            );
          })
        )}
      </div>

      {/* Action row */}
      <div className="mt-4 border-border/50 border-t pt-4">
        <ActionRow
          canHit={canHit}
          canScry={canScry}
          canSecondChance={canSecondChance}
          canStay={canStay}
          isConnected={publicKey !== null}
          playerHasJoined={playerHasJoined}
        />
      </div>

      {/* Flip Advisor — only useful once joined and the round is active */}
      {playerHasJoined && (
        <div className="mt-4">
          <FlipAdvisor />
        </div>
      )}

      {/* Event feed — derived from GameSession state diffs */}
      <div className="mt-4">
        <EventFeed />
      </div>

      {/* Scry result modal — fires when hasUsedScry flips false → true */}
      <ScryResultModal />
    </BoardShell>
  );
}

function ScryResultModal() {
  const { wasScried, dismiss } = useScryResult();
  return (
    <Dialog onOpenChange={(open) => !open && dismiss()} open={wasScried}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Scry burned</DialogTitle>
          <DialogDescription>
            You burned 25 $FLIP to peek at the next card.
          </DialogDescription>
        </DialogHeader>
        <p className="rounded border border-border bg-muted/30 p-3 text-muted-foreground text-sm">
          The peeked card is revealed off-chain by the dealer service. Once the
          dealer HTTP integration is wired in (Phase 4), the actual card will
          appear here. For now this modal just confirms the burn succeeded —
          auto-dismisses in 5 seconds.
        </p>
        <DialogFooter>
          <Button onClick={dismiss}>OK</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BoardShell({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-4 text-card-foreground">
      {children}
    </section>
  );
}

/**
 * Skeleton placeholder shown while `useGameSession` is loading the
 * GameSession account for the first time. Mirrors the rough geometry
 * of a fully-rendered `<GameBoard>` so the layout doesn't jump when
 * real data arrives:
 *
 *   - Top row: title block + pot card
 *   - Player hand row: one card-sized strip
 *   - Action row: four button-sized blocks
 *   - Footer: thin event-feed strip
 *
 * Subsequent refetches do NOT show the skeleton (React Query keeps
 * the previous data and switches to the loading-with-data state).
 * Only the first cold load shows skeletons.
 */
function BoardSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <div className="space-y-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
        <Skeleton className="h-24 w-32" />
      </div>
      <Skeleton className="h-40 w-full" />
      <div className="flex flex-wrap gap-2 border-border/50 border-t pt-4">
        <Skeleton className="h-9 w-16" />
        <Skeleton className="h-9 w-16" />
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-9 w-24" />
      </div>
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

interface ActionRowProps {
  canHit: boolean;
  canScry: boolean;
  canSecondChance: boolean;
  canStay: boolean;
  isConnected: boolean;
  playerHasJoined: boolean;
}

/**
 * Three-state row under the player hands:
 *   - wallet not connected → prompt to connect
 *   - connected but not joined → prompt to use the join dialog
 *   - connected and joined → ActionButtons with derived can-* gating
 *
 * Extracted into its own component to avoid a nested ternary in the
 * GameBoard render — biome's noNestedTernary rule.
 */
function ActionRow({
  canHit,
  canScry,
  canSecondChance,
  canStay,
  isConnected,
  playerHasJoined,
}: ActionRowProps) {
  if (!isConnected) {
    return (
      <p className="text-center text-muted-foreground text-sm">
        Connect your wallet to play.
      </p>
    );
  }
  if (!playerHasJoined) {
    return (
      <div className="flex flex-col items-center gap-3">
        <p className="text-center text-muted-foreground text-sm">
          You have not joined this game yet. Stake $FLIP and enter the round to
          start playing.
        </p>
        <JoinGameDialog trigger={<Button size="lg">Join game</Button>} />
      </div>
    );
  }
  return (
    <ActionButtons
      canHit={canHit}
      canScry={canScry}
      canSecondChance={canSecondChance}
      canStay={canStay}
    />
  );
}
