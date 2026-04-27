/**
 * Display formatters for wallet addresses.
 *
 * The canonical truncation `slice(0,4) + "…" + slice(-4)` lived in
 * four inlined copies in the codebase before Pre-Mainnet 5.0.10
 * (game-board.tsx, turn-indicator.tsx, wallet-button.tsx, and
 * event-render.ts). 5.0.10 promoted three of those to `<DisplayName>`
 * and left two stragglers — `truncateAddress` in the hook (the
 * faucet-down fallback) and `shortAddress` in `event-render.ts` (the
 * plain-text toast renderer). This module is the single source of
 * truth so both can import the same byte-for-byte function.
 */

/**
 * Truncate a base58 wallet address to its first and last 4 chars
 * separated by an ellipsis: `UoZh…naxa`. Used by the offline fallback
 * in `useDisplayName` and the plain-text variant of the event renderer.
 */
export function truncateAddress(addressBase58: string): string {
  return `${addressBase58.slice(0, 4)}…${addressBase58.slice(-4)}`;
}
