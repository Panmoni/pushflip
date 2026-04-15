/**
 * In-memory per-wallet rate limiter. Devnet-only; for production a
 * process-restart-durable store (SQLite, Redis, PlanetScale, whatever)
 * would replace this so a crash + restart doesn't wipe all cooldowns.
 *
 * Key: recipient wallet address (base58 string). Values:
 *   - `lastClaim` — timestamp of the last successful mint.
 *   - `pendingClaims` — wallets currently mid-mint. Prevents the
 *     concurrent-request bypass where N parallel POSTs for the same
 *     wallet all clear `checkRateLimit` before any of them records a
 *     claim. Exposed via `tryAcquireClaim` / `releaseClaim` so the
 *     check+acquire is atomic under Node's single-threaded event loop.
 *     (16th heavy-duty review, Critical fix.)
 *
 * The rate limit is INTENTIONALLY keyed on the recipient wallet, not
 * the requester IP. An attacker rotating IPs can't bypass it; an
 * attacker rotating wallets can, but devnet test tokens have no
 * monetary value — sybil resistance is not the goal.
 */

import { CONFIG } from "./config";

const lastClaim = new Map<string, number>();
const pendingClaims = new Set<string>();

export type AcquireDecision =
  | { status: "ok" }
  | { status: "in_flight" }
  | {
      status: "cooldown";
      /** When the wallet can next request, as a Unix millisecond timestamp. */
      nextAvailableAt: number;
      /** Seconds until the next allowed request. */
      retryAfterSeconds: number;
    };

/**
 * Atomic check-and-reserve. If the wallet is neither in cooldown nor
 * mid-mint, marks it as pending and returns ok. The caller MUST call
 * `releaseClaim(wallet, success)` in a finally block, passing true on
 * mint success (records the claim, blocks for the full cooldown
 * window) or false on failure (clears pending, allows immediate retry).
 *
 * This is safe to call without a mutex because Node's event loop is
 * single-threaded: `get` / `has` / `add` all run to completion before
 * any other handler sees the state.
 */
export function tryAcquireClaim(wallet: string): AcquireDecision {
  if (pendingClaims.has(wallet)) {
    return { status: "in_flight" };
  }
  const now = Date.now();
  const last = lastClaim.get(wallet);
  if (last !== undefined) {
    const elapsed = now - last;
    if (elapsed < CONFIG.cooldownMs) {
      const nextAvailableAt = last + CONFIG.cooldownMs;
      const retryAfterSeconds = Math.ceil((nextAvailableAt - now) / 1000);
      return { status: "cooldown", nextAvailableAt, retryAfterSeconds };
    }
  }
  pendingClaims.add(wallet);
  return { status: "ok" };
}

/**
 * Release the reservation. On success, record the claim to start the
 * cooldown window. On failure, clear the pending flag without
 * recording — the user can retry immediately.
 */
export function releaseClaim(wallet: string, success: boolean): void {
  pendingClaims.delete(wallet);
  if (success) {
    lastClaim.set(wallet, Date.now());
  }
}

/** Test-only: clear the in-memory state. */
export function __resetRateLimitForTesting(): void {
  lastClaim.clear();
  pendingClaims.clear();
}
