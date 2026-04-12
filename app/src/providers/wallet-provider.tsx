/**
 * Wallet adapter context.
 *
 * Wraps `@solana/wallet-adapter-react`'s `ConnectionProvider` and
 * `WalletProvider` plus the modal UI from `@solana/wallet-adapter-react-ui`.
 *
 * Bridge note: the wallet adapter ecosystem is built on `@solana/web3.js` v1.
 * `ConnectionProvider` constructs a `Connection` instance internally and
 * exposes it via `useConnection()`. We do NOT use that connection for
 * on-chain reads / instruction building — that's what `@/lib/program`'s Kit
 * RPC is for. We only use the wallet adapter for:
 *   1. The connect/disconnect UI flow
 *   2. The signer for transactions (via `useWallet().signTransaction`)
 * The Kit ↔ web3.js translation happens at the call site via
 * `@solana/compat`'s `fromLegacyPublicKey` / `fromLegacyTransactionInstruction`
 * helpers in the action hooks (Task 3.2.3).
 */

import type { WalletError } from "@solana/wallet-adapter-base";
import {
  WalletProvider as BaseWalletProvider,
  ConnectionProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import { type ReactNode, useCallback, useMemo } from "react";
import { toast } from "sonner";

import { RPC_ENDPOINT } from "@/lib/constants";

interface WalletProviderProps {
  children: ReactNode;
}

export function WalletProvider({ children }: WalletProviderProps) {
  // Empty wallets array — every modern Solana wallet (Phantom 2024+,
  // Solflare 2024+, Backpack, Glow, ...) registers itself via the
  // Wallet Standard protocol on `window.navigator.wallets`, and
  // `@solana/wallet-adapter-react@0.15.30+` discovers them
  // automatically without needing explicit adapter constructors.
  //
  // Earlier versions of this provider passed
  // `[new PhantomWalletAdapter(), new SolflareWalletAdapter()]` here,
  // which produced two console warnings on every page load:
  //
  //   "Phantom was registered as a Standard Wallet. The Wallet
  //    Adapter for Phantom can be removed from your app."
  //   "Solflare was registered as a Standard Wallet. The Wallet
  //    Adapter for Solflare can be removed from your app."
  //
  // Removing the explicit adapters drops both warnings, slims the
  // bundle (the `@solana/wallet-adapter-phantom` and
  // `@solana/wallet-adapter-solflare` packages can also be removed
  // from package.json in a follow-up — they're now unused).
  //
  // The memoized empty array still gets a stable reference so
  // `BaseWalletProvider` doesn't tear down its internal state on
  // every render.
  const wallets = useMemo(() => [], []);

  const onError = useCallback((error: WalletError) => {
    // Surface adapter errors as toasts so the user sees them. The wallet
    // adapter itself logs the underlying error chain to the console, so we
    // don't need to duplicate that here.
    toast.error(error.name, { description: error.message });
  }, []);

  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT}>
      <BaseWalletProvider
        autoConnect={true}
        onError={onError}
        wallets={wallets}
      >
        <WalletModalProvider>{children}</WalletModalProvider>
      </BaseWalletProvider>
    </ConnectionProvider>
  );
}
