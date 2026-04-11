import {
  type Card,
  CardType,
  type GameSession,
  type PlayerState,
} from "@pushflip/client";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

import { GameCard } from "@/components/game/card";
import { Toaster } from "@/components/ui/sonner";
import { useGameSession } from "@/hooks/use-game-session";
import { usePlayerState } from "@/hooks/use-player-state";
import { GAME_ID } from "@/lib/constants";
import { QueryProvider } from "@/providers/query-provider";
import { WalletProvider } from "@/providers/wallet-provider";

/*
 * Phase 3.2 verification panel — exercises useGameSession + usePlayerState
 * end-to-end against devnet so we can confirm the React Query + Kit
 * subscription pattern works before Task 3.3 builds the real GameBoard.
 *
 * Will be replaced by `<GameBoard>` in Task 3.3.4.
 */

function StatusLine({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground text-sm">{children}</p>;
}

function ErrorLine({ message }: { message: string }) {
  return <p className="text-destructive text-sm">Error: {message}</p>;
}

function GameSessionDetails({ pda, data }: { pda: string; data: GameSession }) {
  return (
    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted-foreground">PDA</dt>
      <dd className="font-mono text-xs">{pda}</dd>
      <dt className="text-muted-foreground">Round active</dt>
      <dd>{data.roundActive ? "yes" : "no"}</dd>
      <dt className="text-muted-foreground">Round number</dt>
      <dd>{data.roundNumber.toString()}</dd>
      <dt className="text-muted-foreground">Player count</dt>
      <dd>{data.playerCount}</dd>
      <dt className="text-muted-foreground">Pot</dt>
      <dd>{data.potAmount.toString()}</dd>
      <dt className="text-muted-foreground">Deck committed</dt>
      <dd>{data.deckCommitted ? "yes" : "no"}</dd>
    </dl>
  );
}

function PlayerStateDetails({ pda, data }: { pda: string; data: PlayerState }) {
  return (
    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted-foreground">PDA</dt>
      <dd className="font-mono text-xs">{pda}</dd>
      <dt className="text-muted-foreground">Hand size</dt>
      <dd>{data.handSize}</dd>
      <dt className="text-muted-foreground">Score</dt>
      <dd>{data.score.toString()}</dd>
      <dt className="text-muted-foreground">Active</dt>
      <dd>{data.isActive ? "yes" : "no"}</dd>
      <dt className="text-muted-foreground">Staked</dt>
      <dd>{data.stakedAmount.toString()}</dd>
    </dl>
  );
}

function GameSessionSection() {
  const query = useGameSession(GAME_ID);

  let body: React.ReactNode;
  if (query.isLoading) {
    body = <StatusLine>Loading…</StatusLine>;
  } else if (query.isError) {
    body = <ErrorLine message={query.error.message} />;
  } else if (query.data?.data) {
    body = <GameSessionDetails data={query.data.data} pda={query.data.pda} />;
  } else {
    body = (
      <StatusLine>
        No GameSession at PDA{" "}
        <span className="font-mono text-xs">
          {query.data?.pda ?? "(deriving…)"}
        </span>
        . Initialize game_id={GAME_ID.toString()} on devnet to populate this
        panel.
      </StatusLine>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4 text-card-foreground">
      <h2 className="font-semibold text-lg">
        GameSession (game_id = {GAME_ID.toString()})
      </h2>
      {body}
    </section>
  );
}

function PlayerStateSection() {
  const { connected } = useWallet();
  const query = usePlayerState(GAME_ID);

  let body: React.ReactNode;
  if (!connected) {
    body = (
      <StatusLine>
        Connect your wallet to derive your PlayerState PDA.
      </StatusLine>
    );
  } else if (query.isLoading) {
    body = <StatusLine>Loading…</StatusLine>;
  } else if (query.isError) {
    body = <ErrorLine message={query.error.message} />;
  } else if (query.data?.data) {
    body = <PlayerStateDetails data={query.data.data} pda={query.data.pda} />;
  } else {
    body = (
      <StatusLine>
        You have not joined this game yet. PDA{" "}
        <span className="font-mono text-xs">
          {query.data?.pda ?? "(deriving…)"}
        </span>{" "}
        is empty.
      </StatusLine>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4 text-card-foreground">
      <h2 className="font-semibold text-lg">PlayerState (your wallet)</h2>
      {body}
    </section>
  );
}

/*
 * Task 3.3.1 visual showcase — renders one of each GameCard variant so
 * you can eyeball them in the dev server. Removed when Task 3.3.4
 * (`<GameBoard>`) lands and consumes GameCard for real.
 */
const SHOWCASE_CARDS: Array<{ label: string; card: Card }> = [
  { label: "Alpha ♠ A", card: { value: 1, cardType: CardType.Alpha, suit: 0 } },
  {
    label: "Alpha ♥ Q",
    card: { value: 12, cardType: CardType.Alpha, suit: 1 },
  },
  { label: "Alpha ♦ 7", card: { value: 7, cardType: CardType.Alpha, suit: 2 } },
  {
    label: "Alpha ♣ K",
    card: { value: 13, cardType: CardType.Alpha, suit: 3 },
  },
  {
    label: "Protocol RugPull",
    card: { value: 0, cardType: CardType.Protocol, suit: 0 },
  },
  {
    label: "Protocol Airdrop",
    card: { value: 1, cardType: CardType.Protocol, suit: 0 },
  },
  {
    label: "Protocol Vampire",
    card: { value: 2, cardType: CardType.Protocol, suit: 0 },
  },
  {
    label: "Multiplier ×2",
    card: { value: 2, cardType: CardType.Multiplier, suit: 0 },
  },
  {
    label: "Multiplier ×5",
    card: { value: 5, cardType: CardType.Multiplier, suit: 0 },
  },
];

function CardShowcase() {
  return (
    <section className="rounded-lg border border-border bg-card p-4 text-card-foreground">
      <h2 className="font-semibold text-lg">GameCard showcase (Task 3.3.1)</h2>
      <p className="mt-1 text-muted-foreground text-sm">
        Visual smoke test — all three variants plus the face-down state. Removed
        when Task 3.3.4 ships <code className="text-xs">&lt;GameBoard&gt;</code>
        .
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        {SHOWCASE_CARDS.map(({ label, card }) => (
          <div className="flex flex-col items-center gap-1" key={label}>
            <GameCard card={card} />
            <span className="text-muted-foreground text-xs">{label}</span>
          </div>
        ))}
        <div className="flex flex-col items-center gap-1">
          <GameCard
            card={{ value: 0, cardType: CardType.Alpha, suit: 0 }}
            faceDown
          />
          <span className="text-muted-foreground text-xs">Face-down</span>
        </div>
      </div>
    </section>
  );
}

function GameStatusPanel() {
  return (
    <div className="space-y-6 text-left">
      <CardShowcase />
      <GameSessionSection />
      <PlayerStateSection />
    </div>
  );
}

function App() {
  return (
    <QueryProvider>
      <WalletProvider>
        <div className="flex min-h-screen flex-col bg-background text-foreground">
          <header className="flex items-center justify-between border-border border-b px-6 py-4">
            <h1 className="font-bold text-xl">pushflip</h1>
            <WalletMultiButton />
          </header>

          <main className="flex flex-1 justify-center p-6">
            <div className="w-full max-w-2xl">
              <GameStatusPanel />
            </div>
          </main>

          <footer className="border-border border-t px-6 py-3 text-center text-muted-foreground text-sm">
            devnet · @pushflip/app · Phase 3.2 hooks live · Task 3.3.1 GameCard
            live
          </footer>
        </div>

        <Toaster />
      </WalletProvider>
    </QueryProvider>
  );
}

export default App;
