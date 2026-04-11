/**
 * `$FLIP` token formatting helpers.
 *
 * Display-only helpers for rendering $FLIP base-unit `bigint` values as
 * human-readable strings (full-precision and compact k/M/B modes). These
 * cannot live in `@pushflip/client` because they are React-adjacent
 * presentation logic; the client package stays on-chain-only.
 *
 * **Parsing lives in `@pushflip/client`** — `parseU64` and `U64_MAX`
 * live there (added in Pre-Mainnet 5.0.4) so the frontend, scripts, and
 * dealer share one validator. Import them from `@pushflip/client`
 * directly; don't route parsing through this module.
 *
 * **WHY THIS FILE EXISTS** — heavy-duty review #10 caught three separate
 * copies of `FLIP_SCALE = 10n ** BigInt(FLIP_DECIMALS)` and four nearly
 * identical formatter functions across `pot-display.tsx`,
 * `wallet-button.tsx`, and `join-game-dialog.tsx`. Consolidating here.
 */

import { FLIP_DECIMALS } from "@pushflip/client";

/** Multiplier to convert whole $FLIP to base units. 10^9 since FLIP_DECIMALS = 9. */
export const FLIP_SCALE: bigint = 10n ** BigInt(FLIP_DECIMALS);

// --- Format helpers ------------------------------------------------------

export interface FormatFlipOptions {
  /**
   * Compact mode — uses k/M/B suffixes for amounts >= 1000 and rounds to
   * 1-2 decimal places. Used by the wallet button pill where space is
   * tight. Off by default (full precision).
   */
  compact?: boolean;
}

/**
 * Format a base-unit `bigint` into a human-readable $FLIP string.
 *
 * Default mode (compact: false): full precision, drops trailing zeros.
 *   100_000_000_000n             → "100"
 *   100_500_000_000n             → "100.5"
 *   1_500_000_000_000_000n       → "1,500,000"
 *
 * Compact mode (compact: true): k/M/B suffixes for thousands/millions/
 * billions, 1-2 decimal places under the suffix.
 *   100_000_000_000n             → "100"
 *   12_500_000_000_000n          → "12.5k"
 *   1_500_000_000_000_000n       → "1.5M"
 *
 * **Precision**: compact mode uses `Number(whole)` for the suffix
 * arithmetic, which can lose precision for whole-FLIP amounts above
 * `Number.MAX_SAFE_INTEGER` (~9.0×10^15 = 9 quadrillion FLIP). Display-
 * only — never use the result for calculations. Full mode is precise
 * for any u64 value.
 */
export function formatFlip(
  baseUnits: bigint,
  options: FormatFlipOptions = {}
): string {
  if (options.compact) {
    return formatFlipCompactInternal(baseUnits);
  }
  const whole = baseUnits / FLIP_SCALE;
  const remainder = baseUnits % FLIP_SCALE;
  if (remainder === 0n) {
    return whole.toLocaleString("en-US");
  }
  const fractional = remainder.toString().padStart(FLIP_DECIMALS, "0");
  const trimmed = fractional.replace(TRAILING_ZEROS_RE, "");
  return `${whole.toLocaleString("en-US")}.${trimmed}`;
}

const TRAILING_ZEROS_RE = /0+$/;

function formatFlipCompactInternal(baseUnits: bigint): string {
  const whole = baseUnits / FLIP_SCALE;
  if (whole >= 1_000_000_000n) {
    const bil = Number(whole) / 1_000_000_000;
    return `${bil.toFixed(bil < 10 ? 2 : 1)}B`;
  }
  if (whole >= 1_000_000n) {
    const mil = Number(whole) / 1_000_000;
    return `${mil.toFixed(mil < 10 ? 2 : 1)}M`;
  }
  if (whole >= 1_000n) {
    const k = Number(whole) / 1000;
    return `${k.toFixed(k < 10 ? 2 : 1)}k`;
  }
  return whole.toLocaleString("en-US");
}
