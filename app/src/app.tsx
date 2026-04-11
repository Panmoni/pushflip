import { GameBoard } from "@/components/game/game-board";
import { Toaster } from "@/components/ui/sonner";
import { ClusterHint } from "@/components/wallet/cluster-hint";
import { ConnectionStatus } from "@/components/wallet/connection-status";
import { ThemeToggle } from "@/components/wallet/theme-toggle";
import { WalletButton } from "@/components/wallet/wallet-button";
import { useTheme } from "@/hooks/use-theme";
import { QueryProvider } from "@/providers/query-provider";
import { WalletProvider } from "@/providers/wallet-provider";

function App() {
  // Mount the theme hook once at the root so the OS-preference media
  // query listener and the `.dark` class on <html> are managed in one
  // place. The actual control surface lives in <ThemeToggle> in the
  // header (which calls the same hook).
  useTheme();

  return (
    <QueryProvider>
      <WalletProvider>
        <div className="flex min-h-screen flex-col bg-background text-foreground">
          <header className="flex flex-wrap items-center justify-between gap-y-2 border-border border-b px-6 py-4">
            <h1 className="font-bold text-xl">pushflip</h1>
            {/* Right-side action cluster. `flex-wrap` lets the group
                drop to a second line on narrow screens where
                <ConnectionStatus> + <ThemeToggle> + <WalletButton>
                together would overflow the title row. */}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <ConnectionStatus />
              <ThemeToggle />
              <WalletButton />
            </div>
          </header>

          {/* Devnet-cluster reminder. Only renders when a wallet is
              connected; dismissible per-session. Pairs with the
              wallet-bridge's reactive `isWalletClusterMismatch`
              detection as belt-and-suspenders. */}
          <ClusterHint />

          <main className="flex flex-1 justify-center p-6">
            <div className="w-full max-w-3xl">
              <GameBoard />
            </div>
          </main>

          <footer className="border-border border-t px-6 py-3 text-center text-muted-foreground text-sm">
            <a
              className="hover:text-foreground"
              href="https://pushflip.xyz"
              rel="noopener noreferrer"
              target="_blank"
            >
              pushflip.xyz
            </a>
            <span className="mx-2">·</span>
            devnet
          </footer>
        </div>

        <Toaster />
      </WalletProvider>
    </QueryProvider>
  );
}

export default App;
