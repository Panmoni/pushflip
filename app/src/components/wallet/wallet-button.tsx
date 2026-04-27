/**
 * WalletButton — header wallet UI.
 *
 * Connected state: pill showing the truncated wallet address + the
 * connected wallet's $FLIP balance, plus a small disconnect chevron.
 * Disconnected state: defers entirely to `<WalletMultiButton>` from
 * `@solana/wallet-adapter-react-ui` so the connect flow + modal stay
 * exactly as the wallet adapter ships them. We only customize the
 * connected state.
 *
 * Why two different components for the two states:
 *  - The wallet adapter's modal is non-trivial (provider list, install
 *    detection, deep-linking) and we don't want to reimplement it.
 *  - The connected display is small and bespoke, and we want it to
 *    show the live $FLIP balance — which requires our own hook.
 *
 * Spec: docs/EXECUTION_PLAN.md Task 3.4.1.
 */

import { fromLegacyPublicKey } from "@solana/compat";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

import { DisplayName } from "@/components/misc/display-name";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTokenBalance } from "@/hooks/use-token-balance";
import { formatFlip } from "@/lib/flip-format";
import { cn } from "@/lib/utils";

/**
 * Three-state display string for the wallet's $FLIP balance.
 * Extracted out of JSX to avoid biome's noNestedTernary rule.
 */
function balanceLabel(isLoading: boolean, balance: bigint | null): string {
  if (isLoading) {
    return "loading…";
  }
  if (balance === null) {
    return "no $FLIP";
  }
  return `${formatFlip(balance, { compact: true })} $FLIP`;
}

export interface WalletButtonProps {
  className?: string;
}

export function WalletButton({ className }: WalletButtonProps) {
  const { publicKey, disconnect, connecting } = useWallet();
  const balanceQuery = useTokenBalance();

  if (publicKey === null) {
    // Defer to the wallet adapter's stock connect button + modal.
    return (
      <div className={cn("wallet-button-host", className)}>
        <WalletMultiButton />
      </div>
    );
  }

  const kitAddress = fromLegacyPublicKey(publicKey);
  const balance = balanceQuery.data?.balance ?? null;

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5",
        className
      )}
      data-testid="wallet-button"
    >
      <div className="flex flex-col items-end leading-tight">
        {/* DisplayName resolves a globally-unique adjective-noun
            nickname from the faucet registry (Pre-Mainnet 5.0.10).
            Falls back to truncated `4…4` if the faucet is unreachable.
            `title` (set inside DisplayName) carries the full base58 so
            the user can hover-verify and the truncation can never
            produce a visual collision attack (heavy-duty review #10
            finding #12). */}
        <DisplayName address={kitAddress} className="text-foreground text-sm" />
        {balanceQuery.isLoading ? (
          <Skeleton className="h-3 w-16" />
        ) : (
          <span className="font-mono text-amber-700 text-xs tabular-nums dark:text-amber-300">
            {balanceLabel(false, balance)}
          </span>
        )}
      </div>
      <Button
        aria-label="Disconnect wallet"
        disabled={connecting}
        onClick={() => {
          disconnect().catch(() => {
            // Wallet adapter raises its own toast on disconnect failure.
          });
        }}
        size="sm"
        variant="ghost"
      >
        ×
      </Button>
    </div>
  );
}
