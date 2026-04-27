/**
 * `<DisplayName>` — renders a wallet address as its registered
 * nickname (or a truncated `4…4` fallback when the registry is
 * unreachable). Pre-Mainnet 5.0.10.
 *
 * Wraps `useDisplayNameOrFallback` so callers don't need to handle
 * loading/error/null states manually. The component always renders a
 * single `<span>` — never a skeleton — so layout stays stable even
 * when the registry round-trip is in flight (the truncated fallback
 * is the placeholder during loading; once the real nickname arrives,
 * the span text updates in place).
 *
 * Why no skeleton: the truncated form `UoZh…naxa` is always usable as
 * a label, and most users will see it for ~30–80 ms before the
 * nickname resolves. A skeleton during that window would flash and
 * draw the eye more than the swap. Same reasoning the wallet pill
 * uses for the address line — it's never a skeleton, just shows the
 * address while the balance loads.
 *
 * The `title` attribute carries the full base58 address for
 * hover-verification (per heavy-duty review #10 finding #12 — the
 * same defense the previous inlined `shortAddress` used).
 */

import type { Address } from "@solana/kit";

import { useDisplayNameOrFallback } from "@/hooks/use-display-name";
import { cn } from "@/lib/utils";

export interface DisplayNameProps {
  address: Address | null;
  /** Optional element type override for callers that need a non-default tag. */
  as?: "span";
  /** Optional class on the wrapper span. */
  className?: string;
}

export function DisplayName({ address, className }: DisplayNameProps) {
  const display = useDisplayNameOrFallback(address);
  const fullAddress = address?.toString();
  return (
    <span
      className={cn(
        "tabular-nums",
        // Subtle visual cue distinguishes the truncated fallback (when
        // the registry is unreachable) from the real nickname. Keeps
        // the difference visible without being loud.
        display.source === "fallback" && "font-mono",
        className
      )}
      data-display-name-source={display.source}
      title={fullAddress}
    >
      {display.name}
    </span>
  );
}
