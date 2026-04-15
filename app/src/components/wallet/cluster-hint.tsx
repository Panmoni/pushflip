/**
 * ClusterHint — persistent banner reminding the user that pushflip is
 * devnet-only and their wallet must be on the same cluster.
 *
 * **Why this exists**: Phantom (and most wallet adapters) simulate
 * transactions internally against whatever cluster the wallet is
 * configured for — mainnet by default. The app cannot read or change
 * the wallet's cluster setting programmatically, so a user connecting
 * a mainnet-configured wallet gets a confusing "This transaction
 * reverted during simulation. Funds may be lost if submitted." error
 * from Phantom on any action, even though the transaction would
 * succeed on devnet. The banner pre-empts that confusion by telling
 * the user exactly what to do before they ever click Join.
 *
 * Rendering rules:
 *   - Only shown when a wallet is connected (no wallet → nothing to
 *     warn about yet).
 *   - Dismissible. The dismissed state is remembered in sessionStorage
 *     so the banner doesn't re-appear every page load within a
 *     session, but DOES re-appear if the user opens a fresh tab —
 *     catching the case where they may have switched devices and
 *     forgotten their earlier "I know" dismissal.
 *   - An "i" disclosure toggles Phantom-specific step-by-step
 *     instructions (Phantom is the dominant wallet in the ecosystem,
 *     and the instructions translate cleanly to most others).
 *
 * This component pairs with the wallet-bridge's `isWalletClusterMismatch`
 * detection: the banner is the proactive reminder, the detection is the
 * reactive catch-net for users who missed the banner.
 */

import { useWallet } from "@solana/wallet-adapter-react";
import { InfoIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { cn } from "@/lib/utils";

const DISMISS_KEY = "pushflip:cluster-hint-dismissed";

function readDismissed(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(value: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (value) {
      window.sessionStorage.setItem(DISMISS_KEY, "1");
    } else {
      window.sessionStorage.removeItem(DISMISS_KEY);
    }
  } catch {
    // sessionStorage disabled; dismissal stays in-memory only.
  }
}

export interface ClusterHintProps {
  className?: string;
}

export function ClusterHint({ className }: ClusterHintProps) {
  const { publicKey } = useWallet();
  const publicKeyBase58 = publicKey?.toBase58() ?? null;
  const [dismissed, setDismissed] = useState<boolean>(readDismissed);
  const [showDetails, setShowDetails] = useState(false);

  // When a wallet connects, re-read the dismiss state in case it was
  // written in another tab or an earlier mount cycle. We depend on the
  // base58 string (stable identity) instead of the publicKey object
  // (new identity every render) — Lesson #40 / Pre-Mainnet 5.0.8.
  useEffect(() => {
    if (publicKeyBase58 !== null) {
      setDismissed(readDismissed());
    }
  }, [publicKeyBase58]);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    writeDismissed(true);
  }, []);

  const toggleDetails = useCallback(() => {
    setShowDetails((v) => !v);
  }, []);

  // Nothing to warn about if no wallet is connected — the Join button
  // is already hidden / disabled behind the wallet connect flow.
  if (publicKey === null || dismissed) {
    return null;
  }

  return (
    <div
      aria-label="Devnet reminder"
      className={cn(
        "border-amber-500/60 border-b bg-amber-100/70 px-4 py-2 text-amber-950 text-sm dark:border-amber-400/50 dark:bg-amber-500/10 dark:text-amber-100",
        className
      )}
      role="status"
    >
      <div className="mx-auto flex max-w-3xl items-start gap-2">
        <InfoIcon
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-300"
          size={16}
        />
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            Pushflip is running on{" "}
            <span className="font-mono">Solana Devnet</span>. Make sure your
            wallet is on devnet too.{" "}
            <button
              className="font-medium underline underline-offset-2 hover:text-amber-700 dark:hover:text-amber-50"
              onClick={toggleDetails}
              type="button"
            >
              {showDetails ? "Hide instructions" : "How?"}
            </button>
          </p>
          {showDetails && (
            <ol className="mt-2 list-inside list-decimal space-y-1 text-amber-900/90 text-xs dark:text-amber-100/80">
              <li>Open your wallet extension (Phantom, Solflare, etc.)</li>
              <li>
                Phantom:{" "}
                <span className="font-mono">
                  Settings → Developer Settings → Testnet Mode
                </span>{" "}
                → enable, then pick{" "}
                <span className="font-mono">Solana Devnet</span>
              </li>
              <li>
                Solflare:{" "}
                <span className="font-mono">Settings → Network → Devnet</span>
              </li>
              <li>Refresh this page</li>
            </ol>
          )}
        </div>
        <button
          aria-label="Dismiss devnet reminder"
          className="shrink-0 rounded p-1 text-amber-700 hover:bg-amber-200/50 dark:text-amber-200 dark:hover:bg-amber-400/10"
          onClick={handleDismiss}
          type="button"
        >
          <XIcon aria-hidden="true" size={14} />
        </button>
      </div>
    </div>
  );
}
