/**
 * DemoStageBanner — explains what visitors can and can't do at the
 * current deploy stage of play.pushflip.xyz.
 *
 * **Why this exists**: a first-time visitor can connect a wallet,
 * mint test `$FLIP` via the faucet, and join a round — but then sits
 * waiting forever for the round to start because the dealer service
 * (which calls `commit_deck` + serves card reveals) isn't deployed
 * yet. Without context, this looks like a broken site. The banner
 * pre-empts the confusion.
 *
 * Pairs with [`ClusterHint`](../wallet/cluster-hint.tsx) — same
 * dismissible-banner pattern, different reason. ClusterHint warns
 * about the user's wallet config; this one explains the deploy
 * scope. Both render at the top of the page above `<main>`.
 *
 * Lifetime: this component goes away when the dealer is
 * productionized (Phase 4 / Pre-Mainnet 5.2+). At that point delete
 * the import + usage in `app.tsx` and this file. Tracked alongside
 * the dealer-deploy task in EXECUTION_PLAN.md.
 *
 * Rendering rules:
 *   - Always visible until dismissed (no wallet-connected gate —
 *     first-time visitors land here without a wallet, and they're
 *     exactly the audience that needs the explanation).
 *   - Dismissible. Persisted to sessionStorage; banner re-appears in
 *     fresh tabs/sessions but not within the same browsing session.
 */

import { InfoIcon, XIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { cn } from "@/lib/utils";

const DISMISS_KEY = "pushflip:demo-stage-banner-dismissed";

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

export interface DemoStageBannerProps {
  className?: string;
}

export function DemoStageBanner({ className }: DemoStageBannerProps) {
  const [dismissed, setDismissed] = useState<boolean>(readDismissed);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    writeDismissed(true);
  }, []);

  if (dismissed) {
    return null;
  }

  // Slate palette (not amber): this banner is informational, not a
  // warning. Distinguishes it visually from ClusterHint's amber.
  return (
    <div
      aria-label="Demo stage notice"
      className={cn(
        "border-slate-300 border-b bg-slate-100 px-4 py-2 text-slate-800 text-sm dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-200",
        className
      )}
      role="status"
    >
      <div className="mx-auto flex max-w-3xl items-start gap-2">
        <InfoIcon
          aria-hidden="true"
          className="mt-0.5 h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400"
        />
        <p className="flex-1 leading-relaxed">
          <span className="font-semibold">Demo stage.</span> You can connect a
          wallet, mint test $FLIP from the faucet, and join a round. Full
          gameplay (card reveals, scoring, payout) needs the dealer service —
          not yet deployed. Tracked as Phase 4 in{" "}
          <a
            className="underline decoration-slate-400 underline-offset-2 hover:text-slate-600 dark:decoration-slate-600 dark:hover:text-slate-50"
            href="https://github.com/Panmoni/pushflip/blob/main/docs/EXECUTION_PLAN.md"
            rel="noreferrer"
            target="_blank"
          >
            EXECUTION_PLAN.md
          </a>
          .
        </p>
        <button
          aria-label="Dismiss demo stage notice"
          className="shrink-0 rounded p-1 text-slate-500 hover:bg-slate-200 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          onClick={handleDismiss}
          type="button"
        >
          <XIcon aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
