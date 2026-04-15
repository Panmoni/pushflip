/**
 * `useFaucet` — one-click test-$FLIP minting via the backend faucet
 * service (Pre-Mainnet 5.0.7).
 *
 * Calls `POST /faucet` with the connected wallet's base58 address. The
 * backend pays all fees + signs as the mint authority, so a brand-new
 * wallet with 0 SOL can still receive tokens — this is the core UX
 * property that motivated option 1 (backend service) over option 2
 * (on-chain permissionless faucet program) at plan-selection time.
 *
 * The FAUCET_URL default is `http://localhost:3001/faucet` for local
 * dev. Production should set `VITE_FAUCET_URL` at build time.
 *
 * Shape of the server's responses (see `faucet/src/server.ts`):
 *   200 { status, signature, recipient_ata, amount_base_units, ... }
 *   400 { error }                  — invalid recipient address
 *   429 { error: "rate_limited", retry_after_seconds, ... }
 *   500 { error: "mint_failed", message }
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { TOKEN_MINT } from "@/lib/constants";
import { tokenBalanceQueryKey } from "./use-token-balance";

/**
 * Resolve the faucet URL at module load. Fails loud in production
 * builds when `VITE_FAUCET_URL` is unset — a production build that
 * silently fell back to `http://localhost:3001/faucet` would point
 * every user's browser at their own machine (useless at best,
 * attack surface at worst). In dev we keep the localhost default so
 * `pnpm dev` just works.
 *
 * 16th heavy-duty review High fix.
 */
function resolveFaucetUrl(): string {
  const fromEnv = import.meta.env.VITE_FAUCET_URL as string | undefined;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  if (import.meta.env.DEV) {
    return "http://localhost:3001/faucet";
  }
  throw new Error(
    "VITE_FAUCET_URL is required in production builds. Set it at build time to the deployed faucet service URL.",
  );
}

const FAUCET_URL = resolveFaucetUrl();

export interface FaucetSuccess {
  amountWholeFlip: string;
  explorerUrl: string;
  kind: "ok";
  recipientAta: string;
  signature: string;
}

export interface FaucetRateLimited {
  kind: "rate_limited";
  message: string;
  retryAfterSeconds: number;
}

export interface FaucetFailure {
  kind: "error";
  message: string;
}

export type FaucetResult = FaucetSuccess | FaucetRateLimited | FaucetFailure;

/**
 * Raw request wrapper. Separates the network call from React state so
 * it can be unit-tested without a mounted component. The caller gets a
 * discriminated union back — every terminal state is explicit, no
 * hidden thrown exceptions for network errors.
 */
async function requestFaucet(recipient: string): Promise<FaucetResult> {
  let res: Response;
  try {
    res = await fetch(FAUCET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      kind: "error",
      message: `Faucet service unreachable: ${msg}. Is it running on ${FAUCET_URL}?`,
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {
      kind: "error",
      message: `Faucet returned HTTP ${res.status} with non-JSON body`,
    };
  }

  if (res.status === 200) {
    const ok = body as {
      signature: string;
      recipient_ata: string;
      amount_whole_flip: string;
      explorer_url: string;
    };
    return {
      kind: "ok",
      signature: ok.signature,
      recipientAta: ok.recipient_ata,
      amountWholeFlip: ok.amount_whole_flip,
      explorerUrl: ok.explorer_url,
    };
  }

  if (res.status === 429) {
    const rl = body as { message?: string; retry_after_seconds?: number };
    return {
      kind: "rate_limited",
      retryAfterSeconds: rl.retry_after_seconds ?? 0,
      message:
        rl.message ??
        "This wallet recently requested the faucet. Please try again later.",
    };
  }

  const err = body as { error?: string; message?: string };
  return {
    kind: "error",
    message: err.message ?? err.error ?? `Faucet returned HTTP ${res.status}`,
  };
}

export function useFaucet() {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: requestFaucet,
    onSuccess: (result, recipient) => {
      if (result.kind === "ok") {
        // Invalidate the token-balance query so the dialog picks up the
        // new ATA + balance on the next render. Without this, the user
        // sees "0 (no ATA)" until they reopen the dialog.
        queryClient.invalidateQueries({
          queryKey: tokenBalanceQueryKey(TOKEN_MINT, recipient),
        });
      }
    },
  });

  return {
    request: mutation.mutateAsync,
    isPending: mutation.isPending,
    result: mutation.data ?? null,
    reset: mutation.reset,
  };
}
