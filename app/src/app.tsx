import { GameBoard } from "@/components/game/game-board";
import { Toaster } from "@/components/ui/sonner";
import { ConnectionStatus } from "@/components/wallet/connection-status";
import { WalletButton } from "@/components/wallet/wallet-button";
import { QueryProvider } from "@/providers/query-provider";
import { WalletProvider } from "@/providers/wallet-provider";

function App() {
  return (
    <QueryProvider>
      <WalletProvider>
        <div className="flex min-h-screen flex-col bg-background text-foreground">
          <header className="flex items-center justify-between border-border border-b px-6 py-4">
            <h1 className="font-bold text-xl">pushflip</h1>
            <div className="flex items-center gap-3">
              <ConnectionStatus />
              <WalletButton />
            </div>
          </header>

          <main className="flex flex-1 justify-center p-6">
            <div className="w-full max-w-3xl">
              <GameBoard />
            </div>
          </main>

          <footer className="border-border border-t px-6 py-3 text-center text-muted-foreground text-sm">
            devnet · @pushflip/app · Phase 3.3 GameBoard live
          </footer>
        </div>

        <Toaster />
      </WalletProvider>
    </QueryProvider>
  );
}

export default App;
