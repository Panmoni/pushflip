/**
 * React Query (`@tanstack/react-query`) context.
 *
 * Used by the program-integration hooks in Task 3.2 (`useGameSession`,
 * `usePlayerState`, `useTokenBalance`) to cache RPC reads and dedupe
 * concurrent requests for the same account.
 *
 * The Kit RPC subscriptions in `@/lib/program` push real-time updates into
 * React Query via `queryClient.setQueryData(...)` from inside each hook;
 * stale times are kept conservative because subscriptions are the primary
 * freshness mechanism.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

interface QueryProviderProps {
  children: ReactNode;
}

export function QueryProvider({ children }: QueryProviderProps) {
  // Lazy-init so the client survives StrictMode double-mount in dev without
  // re-running constructors. One client per app instance is the canonical
  // pattern.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Account state is pushed by Kit subscriptions; React Query is
            // mostly a cache + dedupe layer, so a generous staleTime is fine.
            staleTime: 30_000,
            // gcTime is the inactive cache lifetime (formerly cacheTime).
            // The default of 5 minutes is too long for our subscription-push
            // model — we want unmounted queries to drop quickly so the next
            // mount waits for fresh subscription data instead of showing
            // possibly-stale cached values. 1 minute strikes a balance:
            // long enough for tab-switch / route-change re-mounts to be
            // instant, short enough that stale data doesn't linger.
            gcTime: 60_000,
            // Don't retry RPC failures aggressively — devnet rate limits hit
            // fast and a noisy retry loop just makes them worse.
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
