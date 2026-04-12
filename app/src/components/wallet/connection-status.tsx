/**
 * ConnectionStatus — small dot + label showing the RPC connection
 * state. Sits in the header next to the wallet button.
 *
 * Three states:
 *   - connecting (gray) — initial mount, before the first ping resolves
 *   - connected (green) — most recent ping succeeded
 *   - disconnected (red) — two consecutive pings failed
 *
 * Spec: docs/EXECUTION_PLAN.md Task 3.6.4.
 */

import { useRpcConnectionStatus } from "@/hooks/use-rpc-connection-status";
import { cn } from "@/lib/utils";

const STATUS_LABEL = {
  connecting: "Connecting…",
  connected: "Connected",
  disconnected: "Disconnected",
} as const;

const STATUS_DOT = {
  connecting: "bg-muted-foreground",
  connected: "bg-emerald-400",
  disconnected: "bg-red-500",
} as const;

// Theme-aware status text: light mode uses `-700` shades for AA
// contrast on the near-white header background, dark mode keeps the
// brighter `-400` shades.
const STATUS_TEXT = {
  connecting: "text-muted-foreground",
  connected: "text-emerald-700 dark:text-emerald-400",
  disconnected: "text-red-700 dark:text-red-400",
} as const;

export interface ConnectionStatusProps {
  className?: string;
}

export function ConnectionStatus({ className }: ConnectionStatusProps) {
  const { status, lastSlot, lastSuccessAt } = useRpcConnectionStatus();

  const tooltipParts: string[] = [STATUS_LABEL[status]];
  if (lastSlot !== null) {
    tooltipParts.push(`slot ${lastSlot.toString()}`);
  }
  if (lastSuccessAt !== null) {
    const ageSeconds = Math.round((Date.now() - lastSuccessAt) / 1000);
    tooltipParts.push(`${ageSeconds}s ago`);
  }
  const tooltip = tooltipParts.join(" · ");

  return (
    <div
      aria-label={tooltip}
      className={cn(
        "flex items-center gap-1.5 text-xs",
        STATUS_TEXT[status],
        className
      )}
      data-testid="connection-status"
      role="status"
      title={tooltip}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-block h-2 w-2 rounded-full",
          STATUS_DOT[status],
          status === "connected" && "animate-pulse"
        )}
      />
      <span className="hidden sm:inline">{STATUS_LABEL[status]}</span>
    </div>
  );
}
