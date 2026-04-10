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
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import {
  WalletProvider as BaseWalletProvider,
  ConnectionProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { type ReactNode, useCallback, useMemo } from "react";
import { toast } from "sonner";

import { RPC_ENDPOINT } from "@/lib/constants";

interface WalletProviderProps {
  children: ReactNode;
}

export function WalletProvider({ children }: WalletProviderProps) {
  // Memoized so the wallet adapter doesn't re-instantiate on every render.
  // Wallets supporting the Wallet Standard (most modern Solana wallets,
  // including Phantom 2024+ and Solflare 2024+) will be auto-detected via
  // window.navigator; the explicit adapters below are legacy fallbacks.
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );

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
