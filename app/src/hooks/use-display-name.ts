/**
 * `useDisplayName` — fetch a globally-unique nickname for a wallet
 * address from the faucet's registry endpoint (Pre-Mainnet 5.0.10).
 *
 * Wraps `GET ${FAUCET_NICKNAME_BASE}/:address`. Cached by React Query
 * with `staleTime: Infinity` + `gcTime: Infinity` because nicknames
 * are first-come-first-served and permanent — once registered, the
 * mapping never changes for that address. Persistence to localStorage
 * (configured at the QueryClient level by the persist provider, when
 * we wire one) keeps the cold-paint clean across reloads.
 *
 * Returns a discriminated-union result:
 *   - `{ source: "nickname", name }`  — registry hit (the common case)
 *   - `{ source: "fallback", name }`  — registry unreachable / errored;
 *     `name` is the truncated `slice(0,4)…slice(-4)` form. The
 *     fallback is **not** persisted to the cache (subsequent renders
 *     re-attempt the registry).
 *
 * Phase 4 (deferred — gated on mainnet milestone) will layer SNS on
 * top: an `sns` source variant takes precedence over `nickname` when
 * an SNS reverse-lookup hits.
 */

import type { Address } from "@solana/kit";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";

import { truncateAddress } from "@/lib/address-format";

/**
 * Base URL for the nickname registry endpoint. Ends with `/nickname`
 * (no trailing slash); the wallet address is appended per request.
 *
 * Dev default points at the faucet running on localhost:3001. Production
 * builds set `VITE_NICKNAME_URL=/api/nickname` at build time — same
 * shape as `VITE_FAUCET_URL`, same fail-loud production check.
 */
function resolveNicknameBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_NICKNAME_URL as string | undefined;
  if (fromEnv && fromEnv.length > 0) {
    // In production, refuse anything that isn't a same-origin relative
    // path. A misconfigured / malicious build that sets
    // VITE_NICKNAME_URL=https://attacker.example/api/nickname would
    // silently leak every visitor's wallet address to the attacker on
    // first paint. Dev keeps the cross-origin allowance because the
    // Vite dev server is on :5173 and the faucet is on :3001.
    if (!(import.meta.env.DEV || fromEnv.startsWith("/"))) {
      throw new Error(
        `VITE_NICKNAME_URL must be a same-origin relative path starting with "/" in production builds. Got: ${fromEnv}`
      );
    }
    return fromEnv;
  }
  if (import.meta.env.DEV) {
    return "http://localhost:3001/nickname";
  }
  throw new Error(
    "VITE_NICKNAME_URL is required in production builds. Set it at build time to the deployed faucet's nickname endpoint (e.g. /api/nickname)."
  );
}

const NICKNAME_BASE_URL = resolveNicknameBaseUrl();

export type DisplayNameSource = "nickname" | "sns" | "fallback";

export interface DisplayName {
  /** Display string: registered nickname, SNS, or truncated fallback. */
  name: string;
  /** Where the name came from. UI may surface this differently. */
  source: DisplayNameSource;
}

/**
 * Cache key for the React Query cache. Exported for invalidation.
 */
export function displayNameQueryKey(
  addressBase58: string
): readonly [string, string] {
  return ["displayName", addressBase58] as const;
}

interface NicknameResponse {
  address: string;
  assigned: boolean;
  nickname: string;
  status: string;
}

/**
 * Fetch the registered nickname. 3-second timeout via AbortController.
 * Errors and timeouts are swallowed and converted to the truncated
 * fallback by the caller — the queryFn itself returns the success
 * shape only, throwing on every failure so React Query's cache treats
 * the failure as transient.
 *
 * The DOM `AbortSignal.timeout(3000)` is broadly supported in modern
 * browsers (Chrome 103+, Safari 16+, Firefox 100+ — all > 2 years
 * old). For older targets we'd polyfill, but the rest of the stack
 * already requires modern wallet-adapter support.
 */
async function fetchNickname(addressBase58: string): Promise<DisplayName> {
  const url = `${NICKNAME_BASE_URL}/${encodeURIComponent(addressBase58)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`nickname endpoint returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as NicknameResponse;
  if (typeof body.nickname !== "string" || body.nickname.length === 0) {
    throw new Error("nickname endpoint returned empty nickname");
  }
  return { name: body.nickname, source: "nickname" };
}

export interface UseDisplayNameOptions {
  /** Disable the fetch (e.g. while a parent gates on a different state). */
  enabled?: boolean;
}

/**
 * Hook returning the display name for `address`. While loading,
 * `query.data` is `undefined` — callers can render a skeleton or the
 * truncated form depending on UX preference (the `<DisplayName>`
 * component picks one consistent answer).
 *
 * On error (timeout / network / 5xx), the React Query state goes to
 * `error` but the hook still returns a usable `data: { source:
 * "fallback", name: truncate(address) }` via `select`. This keeps the
 * UI rendering the truncated address forever rather than getting stuck
 * on a skeleton.
 */
export function useDisplayName(
  address: Address | null,
  options: UseDisplayNameOptions = {}
): UseQueryResult<DisplayName, Error> {
  const enabled = options.enabled !== false && address !== null;
  const addressBase58 = address?.toString() ?? "";

  return useQuery<DisplayName, Error, DisplayName, readonly [string, string]>({
    queryKey: displayNameQueryKey(addressBase58),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    queryFn: () => fetchNickname(addressBase58),
    // Don't retry — the registry returns 200 on first hit (it
    // registers the address inline), so a non-200 means a real
    // outage. Retrying fast just amplifies load on a degraded faucet.
    retry: false,
  });
}

/**
 * Convenience: returns a single `DisplayName` (never undefined) by
 * collapsing loading + error states into a stable fallback.
 *
 * Used by `<DisplayName>` to keep the call sites tiny. Direct
 * consumers that need to distinguish loading from fallback should use
 * the underlying `useDisplayName` hook.
 */
export function useDisplayNameOrFallback(address: Address | null): DisplayName {
  const query = useDisplayName(address);
  if (address === null) {
    return { name: "—", source: "fallback" };
  }
  if (query.data) {
    return query.data;
  }
  // Loading or error — show the truncated fallback so the UI never
  // renders a flash of nothing or hangs on a skeleton if the faucet
  // is unreachable.
  return { name: truncateAddress(address.toString()), source: "fallback" };
}
