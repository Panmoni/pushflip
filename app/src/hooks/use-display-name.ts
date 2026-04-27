/**
 * `useDisplayName` — fetch a globally-unique nickname for a wallet
 * address from the faucet's registry endpoint (Pre-Mainnet 5.0.10).
 *
 * Wraps `GET ${FAUCET_NICKNAME_BASE}/:address`. Cached by React Query
 * with `staleTime: Infinity` + `gcTime: Infinity` because nicknames
 * are first-come-first-served and permanent — once registered, the
 * mapping never changes for that address.
 *
 * **localStorage persistence (5.0.10.b)**: registered nicknames are
 * mirrored to `pushflip:displayName:<address>` so a hard-refresh
 * doesn't burn a registry round-trip on every address that's already
 * been seen on this device. The mirror is read once via
 * `useQuery`'s `initialData` (so the first render goes straight to
 * the cached nickname, no skeleton flash), and written on each
 * successful fetch via `onSuccess`. Fallbacks are NEVER persisted —
 * a faucet-down session shouldn't poison subsequent reloads.
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
import { useEffect } from "react";

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

/**
 * localStorage key for one address's persisted nickname. Schema-
 * versioned so a future format change can ignore old entries cleanly:
 * bump `STORAGE_SCHEMA_VERSION` and stale entries from older versions
 * are ignored on read (they'll be overwritten on next successful
 * fetch).
 */
const STORAGE_SCHEMA_VERSION = 1;
function storageKey(addressBase58: string): string {
  return `pushflip:displayName:v${STORAGE_SCHEMA_VERSION}:${addressBase58}`;
}

interface StoredDisplayName {
  name: string;
  source: DisplayNameSource;
  v: number;
}

/**
 * Read a persisted nickname for `addressBase58` from localStorage.
 * Returns `undefined` if missing, malformed, schema-mismatched, or
 * not a `nickname`/`sns` source (we never persist fallbacks).
 *
 * Failure is silent: localStorage may be disabled (privacy modes),
 * full, or unavailable in non-browser environments. The hook degrades
 * to fetching from the registry as if the cache were cold.
 */
function readStoredDisplayName(addressBase58: string): DisplayName | undefined {
  if (typeof window === "undefined") {
    return;
  }
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(storageKey(addressBase58));
  } catch {
    return;
  }
  if (raw === null) {
    return;
  }
  let parsed: StoredDisplayName;
  try {
    parsed = JSON.parse(raw) as StoredDisplayName;
  } catch {
    return;
  }
  if (parsed.v !== STORAGE_SCHEMA_VERSION) {
    return;
  }
  if (typeof parsed.name !== "string" || parsed.name.length === 0) {
    return;
  }
  // Only persisted sources are 'nickname' (today) and 'sns' (Phase
  // 4). Anything else — including the truncated 'fallback' — is
  // ignored on read so a registry-down session can't poison reloads.
  if (parsed.source !== "nickname" && parsed.source !== "sns") {
    return;
  }
  return { name: parsed.name, source: parsed.source };
}

/**
 * Persist a nickname for `addressBase58` to localStorage. Only writes
 * for sources that are stable across sessions (`nickname`, `sns`);
 * silently no-ops for fallbacks. Storage failures (quota exceeded,
 * disabled by user) are silent — the in-memory React Query cache
 * still serves the value for the rest of the session.
 */
function writeStoredDisplayName(
  addressBase58: string,
  value: DisplayName
): void {
  if (typeof window === "undefined") {
    return;
  }
  if (value.source !== "nickname" && value.source !== "sns") {
    return;
  }
  const payload: StoredDisplayName = {
    v: STORAGE_SCHEMA_VERSION,
    name: value.name,
    source: value.source,
  };
  try {
    window.localStorage.setItem(
      storageKey(addressBase58),
      JSON.stringify(payload)
    );
  } catch {
    // localStorage full / disabled / private-mode — ignore.
  }
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

  const query = useQuery<
    DisplayName,
    Error,
    DisplayName,
    readonly [string, string]
  >({
    queryKey: displayNameQueryKey(addressBase58),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    queryFn: () => fetchNickname(addressBase58),
    // Don't retry — the registry returns 200 on first hit (it
    // registers the address inline), so a non-200 means a real
    // outage. Retrying fast just amplifies load on a degraded faucet.
    retry: false,
    // Seed from localStorage so a hard-refresh on an address we've
    // already resolved on this device skips the round-trip entirely.
    // `initialData` as a function returns `undefined` when there's
    // nothing to seed (or when the hook is disabled), which React
    // Query treats as no seed. `staleTime: Infinity` means it's
    // never re-fetched once seeded. 5.0.10.b.
    initialData: () =>
      enabled ? readStoredDisplayName(addressBase58) : undefined,
  });

  // Mirror successful fetches back to localStorage. Using an effect
  // because React Query v5 dropped the `onSuccess` query callback;
  // the effect re-fires only when the resolved value or address
  // changes, so the write is at most once per (address, value) pair.
  // Fallbacks are filtered inside `writeStoredDisplayName`.
  useEffect(() => {
    if (query.data && enabled) {
      writeStoredDisplayName(addressBase58, query.data);
    }
  }, [addressBase58, enabled, query.data]);

  return query;
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
