import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

import { Toaster } from "@/components/ui/sonner";
import { QueryProvider } from "@/providers/query-provider";
import { WalletProvider } from "@/providers/wallet-provider";

function App() {
  return (
    <QueryProvider>
      <WalletProvider>
        <div className="flex min-h-screen flex-col bg-background text-foreground">
          <header className="flex items-center justify-between border-border border-b px-6 py-4">
            <h1 className="font-bold text-xl">pushflip</h1>
            <WalletMultiButton />
          </header>

          <main className="flex flex-1 items-center justify-center p-6">
            <div className="space-y-4 text-center">
              <p className="text-muted-foreground">
                Phase 3.1 scaffold complete. Game board lands in Task 3.3.
              </p>
            </div>
          </main>

          <footer className="border-border border-t px-6 py-3 text-center text-muted-foreground text-sm">
            devnet · @pushflip/app
          </footer>
        </div>

        <Toaster />
      </WalletProvider>
    </QueryProvider>
  );
}

export default App;
