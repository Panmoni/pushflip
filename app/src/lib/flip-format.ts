/**
 * `$FLIP` token formatting + parsing helpers.
 *
 * Single source of truth for:
 *   - `FLIP_SCALE` — the bigint multiplier converting whole $FLIP to base units
 *   - `formatFlip` — bigint → human-readable display string (full + compact modes)
 *   - `parseU64` — string → validated bigint, with the same `/^\d+$/` + bounds
 *     check pattern that init-game.ts uses (the canonical fix for the recurring
 *     BigInt-u64 silent-wrap footgun documented in EXECUTION_PLAN.md Lesson #42)
 *
 * Lives in `app/src/lib/` rather than `@pushflip/client` because:
 *  - Pre-Mainnet 5.0.4 will eventually move `parseU64` into `@pushflip/client`
 *    so the dealer + scripts + frontend share one helper. Until then, the
 *    frontend gets its own copy that mirrors the same regex + bounds shape.
 *  - The format helpers are display-only and don't belong in the on-chain
 *    client package — they would create a circular dep with React-only
 *    formatting logic.
 *
 * **WHY THIS FILE EXISTS** — heavy-duty review #10 caught three separate
 * copies of `FLIP_SCALE = 10n ** BigInt(FLIP_DECIMALS)` and four nearly
 * identical formatter functions across `pot-display.tsx`,
 * `wallet-button.tsx`, and `join-game-dialog.tsx`. Consolidating here.
 */

import { FLIP_DECIMALS } from "@pushflip/client";

/** Multiplier to convert whole $FLIP to base units. 10^9 since FLIP_DECIMALS = 9. */
export const FLIP_SCALE: bigint = 10n ** BigInt(FLIP_DECIMALS);

/** Maximum value for a u64 — used as the upper bound in `parseU64`. */
export const U64_MAX: bigint = 0xffff_ffff_ffff_ffffn;

// --- Parse helpers -------------------------------------------------------

// Hoisted to module scope per biome's useTopLevelRegex rule.
const POSITIVE_INTEGER_RE = /^\d+$/;

/**
 * Parse a user-supplied decimal string into a u64-bounded `bigint`, with
 * strict validation. Mirrors `scripts/init-game.ts::parseU64` so the
 * frontend and the script share the same rejection rules.
 *
 * **Why this is necessary**: `BigInt(userInput)` silently accepts hex
 * (`"0xff"` → 255), negatives (`"-1"`), and values beyond 2^64. When those
 * bigints later hit `setBigUint64` (inside `u64Le()` from `@pushflip/client`),
 * JavaScript silently *wraps*: `2^64` becomes `0n` (would collide with id=0),
 * `-1n` becomes u64::MAX. This footgun has bitten the codebase three times
 * (use-game-actions.joinRound, init-game.ts, and now in this file's earlier
 * draft). The fix is centralizing the validation here so every bigint that
 * flows into a u64 encoder is range-checked first.
 *
 * Accepts: positive decimal integers in `[0, 2^64 - 1]`.
 * Rejects: hex prefixes, negatives, scientific notation, decimals,
 *          empty strings, anything `BigInt()` can't parse, and values
 *          that would overflow u64.
 *
 * @param raw       The user-supplied string (already trimmed; the caller
 *                  should `.trim()` if the input came from a form field).
 * @param fieldName Human-readable name used in error messages.
 */
export function parseU64(raw: string, fieldName: string): bigint {
  if (!POSITIVE_INTEGER_RE.test(raw)) {
    return throwInvalid(
      fieldName,
      raw,
      "expected a positive decimal integer (no hex, no signs, no scientific notation)"
    );
  }
  let parsed: bigint;
  try {
    parsed = BigInt(raw);
  } catch {
    return throwInvalid(fieldName, raw, "BigInt() rejected the value");
  }
  if (parsed > U64_MAX) {
    return throwInvalid(
      fieldName,
      raw,
      `exceeds u64 max (${U64_MAX.toString()})`
    );
  }
  return parsed;
}

function throwInvalid(fieldName: string, raw: string, reason: string): never {
  throw new Error(`Invalid ${fieldName}: ${JSON.stringify(raw)} — ${reason}`);
}

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
