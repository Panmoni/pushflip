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
import {
  createDefaultAddressSelector,
  createDefaultAuthorizationResultCache,
  createDefaultWalletNotFoundHandler,
  SolanaMobileWalletAdapter,
} from "@solana-mobile/wallet-adapter-mobile";
import "@solana/wallet-adapter-react-ui/styles.css";
import { type ReactNode, useCallback, useMemo } from "react";
import { toast } from "sonner";

import { MWA_CHAIN, RPC_ENDPOINT } from "@/lib/constants";

interface WalletProviderProps {
  children: ReactNode;
}

export function WalletProvider({ children }: WalletProviderProps) {
  // Wallet list contains exactly one explicit adapter — the Mobile
  // Wallet Adapter (MWA) for the Solana Seeker / dApp Store TWA path
  // (Phase 2 of `docs/GO_TO_SEEKER.md`).
  //
  // Desktop wallets (Phantom 2024+, Solflare 2024+, Backpack, Glow,
  // ...) still auto-discover via the Wallet Standard protocol on
  // `window.navigator.wallets`; we don't list them explicitly. MWA is
  // the exception because it doesn't have a window-injected sibling —
  // the host wallet (Seed Vault on Seeker, Phantom Mobile, etc.)
  // talks via an Android intent bridge, not via `window.solana`.
  //
  // Why include MWA on non-Android contexts: its `readyState` reports
  // as `Unsupported` outside of an MWA-capable Android browser, so the
  // wallet modal hides it automatically. Including it unconditionally
  // is the documented Solana Mobile pattern — gating it ourselves
  // would mean shipping browser-detection that the adapter already
  // does internally.
  //
  // `appIdentity.uri` MUST match the domain claimed by the
  // `assetlinks.json` we'll publish in Phase 3 — mismatch fails the
  // MWA handshake silently. We derive it from `window.location.origin`
  // at construction time so dev (`http://localhost:5173`) and
  // production (`https://play.pushflip.xyz`) both work without an
  // env-var step.
  //
  // The `useMemo([])` is critical: `BaseWalletProvider` tears down
  // its internal state when the wallets array reference changes.
  // Constructing the adapter inside the memo guarantees one instance
  // for the lifetime of the provider mount.
  const wallets = useMemo(() => {
    // Belt-and-suspenders SSR guard. Vite doesn't SSR our app today,
    // but the adapter constructor reads `navigator` and would throw
    // at module-init time if it ever ran in a Node context.
    if (typeof window === "undefined") {
      return [];
    }
    return [
      new SolanaMobileWalletAdapter({
        addressSelector: createDefaultAddressSelector(),
        appIdentity: {
          name: "PushFlip",
          uri: window.location.origin,
          // Resolved against `appIdentity.uri` — same SVG as the
          // browser favicon and PWA manifest icon source.
          icon: "/favicon.svg",
        },
        authorizationResultCache: createDefaultAuthorizationResultCache(),
        chain: MWA_CHAIN,
        onWalletNotFound: createDefaultWalletNotFoundHandler(),
      }),
    ];
  }, []);

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
