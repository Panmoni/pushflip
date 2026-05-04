import { GameBoard } from "@/components/game/game-board";
import { DemoStageBanner } from "@/components/misc/demo-stage-banner";
import { UpdateBanner } from "@/components/misc/update-banner";
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
            <h1 className="flex items-center gap-2 font-bold text-xl">
              <img
                alt="PushFlip"
                className="h-7 w-7"
                height={28}
                src="/favicon.svg"
                width={28}
              />
              pushflip
            </h1>
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

          {/* PWA update notice. Renders only when the service worker
              registered by vite-plugin-pwa detects a newer deploy.
              Kept ABOVE the other banners so a stale-build user who
              dismisses everything still sees the update prompt — the
              only banner whose action (reload) materially affects
              correctness, not just UX context. */}
          <UpdateBanner />

          {/* Demo-stage notice. Always-on (until dismissed) so first-
              time visitors understand the deploy scope: faucet + join
              work, full gameplay needs the not-yet-deployed dealer.
              Remove this component (and its file) when the dealer
              ships in Phase 4 / Pre-Mainnet 5.2+. */}
          <DemoStageBanner />

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
            <span className="mx-2">·</span>A{" "}
            <img
              alt=""
              aria-hidden="true"
              className="mx-0.5 inline h-[1em] w-[1em] align-[-0.15em]"
              height={16}
              src="/panmoni.svg"
              width={16}
            />
            <a
              className="bg-linear-to-r from-[#00abda] to-[#1476ff] bg-clip-text font-bold text-transparent tracking-wider hover:underline"
              href="https://www.panmoni.com/"
              rel="noopener noreferrer"
              target="_blank"
              title="Panmoni is a Web3 product studio"
            >
              Panmoni
            </a>{" "}
            project
          </footer>
        </div>

        <Toaster />
      </WalletProvider>
    </QueryProvider>
  );
}

export default App;
