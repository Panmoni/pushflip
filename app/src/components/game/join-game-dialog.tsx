/**
 * JoinGameDialog — modal for joining the current game.
 *
 * Wraps `<Dialog>` from shadcn. Shows the connected wallet's $FLIP
 * balance, a stake amount input (whole $FLIP, validated against
 * MIN_STAKE on the client side), and a Confirm button that fires
 * `useGameActions.joinRound(stakeAmount)`.
 *
 * Validation rules (client-side, defense-in-depth — the on-chain
 * program enforces the same constraints):
 *   - Input must be a non-empty positive integer (no decimals, no
 *     hex, no scientific notation, no negative). Reject anything that
 *     fails the `/^\d+$/` regex.
 *   - Stake amount in WHOLE $FLIP must convert to base units >=
 *     MIN_STAKE.
 *   - Stake amount must be <= the player's current ATA balance,
 *     otherwise the on-chain program will fail with insufficient
 *     funds after burning gas.
 *
 * Spec: docs/EXECUTION_PLAN.md Task 3.4.3.
 */

import { MIN_STAKE, parseU64, U64_MAX } from "@pushflip/client";
import { useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useGameActions } from "@/hooks/use-game-actions";
import { useTokenBalance } from "@/hooks/use-token-balance";
import { FLIP_SCALE, formatFlip } from "@/lib/flip-format";
import { cn } from "@/lib/utils";

const MIN_STAKE_WHOLE = MIN_STAKE / FLIP_SCALE;

/**
 * Three-state display string for the dialog's "wallet balance" line.
 * Extracted out of JSX to avoid biome's noNestedTernary rule.
 */
function dialogBalanceLabel(
  isLoading: boolean,
  balance: bigint | null
): string {
  if (isLoading) {
    return "loading…";
  }
  if (balance === null) {
    return "0 (no ATA)";
  }
  return `${formatFlip(balance)} $FLIP`;
}

export interface JoinGameDialogProps {
  className?: string;
  /**
   * The trigger element. Typically a `<Button>`. The dialog manages its
   * own open state but defers to the trigger's click for opening.
   */
  trigger: React.ReactNode;
}

interface ParseResult {
  error: string | null;
  ok: boolean;
  stakeBaseUnits: bigint;
}

/**
 * Parse a user-supplied whole-$FLIP string into base units, with
 * validation. Uses `parseU64` from `@pushflip/client` for the
 * regex + upper-bound check (the canonical fix for the recurring
 * BigInt-u64 silent-wrap footgun — heavy-duty review #10 finding #6).
 *
 * Three failure modes (returned as a single string in `error` —
 * the dialog renders one inline error at a time):
 *  1. Empty / malformed input
 *  2. Stake below MIN_STAKE
 *  3. Stake exceeds u64 max (extremely unlikely in normal use; this
 *     guard exists so a paste of `99999...` doesn't silently wrap
 *     downstream — defense in depth before the on-chain check)
 */
function parseStakeInput(raw: string): ParseResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      ok: false,
      stakeBaseUnits: 0n,
      error: "Enter a stake amount in whole $FLIP",
    };
  }
  let whole: bigint;
  try {
    whole = parseU64(trimmed, "stake amount");
  } catch (error) {
    return {
      ok: false,
      stakeBaseUnits: 0n,
      error:
        error instanceof Error
          ? "Stake must be a positive whole number (no decimals, no hex)"
          : "Stake must be a positive whole number",
    };
  }
  const stakeBaseUnits = whole * FLIP_SCALE;
  // Multiplication can push the result above u64 max even when `whole`
  // itself fits. The on-chain program would reject such a transaction
  // anyway, but failing here is a much better UX than burning gas.
  if (stakeBaseUnits > U64_MAX) {
    return {
      ok: false,
      stakeBaseUnits,
      error: `Stake exceeds u64 max (${U64_MAX.toString()} base units)`,
    };
  }
  if (stakeBaseUnits < MIN_STAKE) {
    return {
      ok: false,
      stakeBaseUnits,
      error: `Stake must be at least ${MIN_STAKE_WHOLE.toString()} $FLIP`,
    };
  }
  return { ok: true, stakeBaseUnits, error: null };
}

export function JoinGameDialog({ trigger, className }: JoinGameDialogProps) {
  const [open, setOpen] = useState(false);
  const [rawStake, setRawStake] = useState(MIN_STAKE_WHOLE.toString());

  const { publicKey } = useWallet();
  const publicKeyBase58 = publicKey?.toBase58() ?? null;
  const balanceQuery = useTokenBalance();
  const { joinRound, isPending } = useGameActions();

  const balance = balanceQuery.data?.balance ?? null;
  const balanceLoading = balanceQuery.isLoading;
  const parsed = parseStakeInput(rawStake);

  // Close the dialog automatically if the wallet disconnects while it is
  // open. Otherwise the no-ATA branch can render `<your-address>` as a
  // literal placeholder, and the Join button is stuck disabled with no
  // way forward — "reconnect your wallet" isn't discoverable from inside
  // the dialog. Fires in the same tick as the publicKey→null transition.
  useEffect(() => {
    if (open && publicKey === null) {
      setOpen(false);
    }
  }, [open, publicKey]);

  // Three layered errors, checked in order so the user sees the most
  // actionable one first:
  //  1. Parse error (malformed input)
  //  2. No-ATA error (wallet has no $FLIP token account at all — must
  //     receive test FLIP before joining; the on-chain join would
  //     otherwise fail with a confusing "account does not exist")
  //  3. Insufficient-balance error (has an ATA but not enough $FLIP)
  //
  // The `no-ata` sentinel is treated as informational rather than as a
  // validation error: the input itself is fine, the wallet just needs
  // faucet-ing. The distinction matters for styling — a well-formed
  // stake should NOT paint the input red when the only "error" is a
  // missing ATA.
  let formError: string | null = parsed.error;
  if (formError === null && parsed.ok && !balanceLoading) {
    if (balance === null && publicKey !== null) {
      formError = "no-ata";
    } else if (balance !== null && parsed.stakeBaseUnits > balance) {
      formError = `Insufficient balance — wallet has ${formatFlip(balance)} $FLIP`;
    }
  }

  // The input is "in an error state" when there is an actual validation
  // failure — parse error or insufficient balance. The `no-ata` case is
  // informational (the user entered a valid number; the wallet just
  // needs to be funded first), so the input border stays neutral.
  const inputHasError = formError !== null && formError !== "no-ata";

  // Submit is disabled if: parse failed, any layered form error fires,
  // a join is in flight, OR the balance query is still loading (we
  // can't reliably check sufficiency until balance resolves).
  const submitDisabled =
    !parsed.ok || formError !== null || isPending || balanceLoading;

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      // Reset the input to the minimum stake so a subsequent open shows
      // a clean starting value rather than whatever the user typed last
      // time (possibly a now-stale huge number that just got rejected).
      setRawStake(MIN_STAKE_WHOLE.toString());
    }
  }, []);

  function handleSubmit() {
    if (!parsed.ok) {
      return;
    }
    joinRound(parsed.stakeBaseUnits)
      .then(() => {
        handleOpenChange(false);
      })
      .catch(() => {
        // No-op — `useGameActions.runAction` already raises a toast on
        // failure (use-game-actions.ts:158). Raising another one here
        // would double-report the same error. The dialog stays open
        // so the user can adjust the stake and retry.
      });
  }

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className={cn("sm:max-w-md", className)}>
        <DialogHeader>
          <DialogTitle>Join the game</DialogTitle>
          <DialogDescription>
            Stake $FLIP to enter the current round. The on-chain minimum is{" "}
            <span className="font-mono">
              {MIN_STAKE_WHOLE.toString()} $FLIP
            </span>
            .
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-muted-foreground">Wallet balance</span>
            <span className="font-mono text-amber-300 tabular-nums">
              {dialogBalanceLabel(balanceQuery.isLoading, balance)}
            </span>
          </div>

          <label className="block">
            <span className="text-foreground text-sm">Stake amount</span>
            <input
              autoComplete="off"
              className={cn(
                "mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-foreground tabular-nums",
                "placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/40",
                inputHasError && "border-destructive focus:ring-destructive/40"
              )}
              inputMode="numeric"
              onChange={(e) => setRawStake(e.target.value)}
              pattern="\d*"
              placeholder={`e.g. ${MIN_STAKE_WHOLE.toString()}`}
              value={rawStake}
            />
            <span className="mt-1 block text-muted-foreground text-xs">
              In whole $FLIP. Min{" "}
              <span className="font-mono">{MIN_STAKE_WHOLE.toString()}</span>.
            </span>
          </label>

          {formError === "no-ata" && publicKeyBase58 !== null ? (
            // Theme-aware palette: in light mode the text sits on a very
            // pale amber background so the foreground must be DARK amber
            // (900/800) to pass contrast. In dark mode the same box lives
            // on a near-black background, so the text flips to LIGHT amber
            // (100/50). The `<code>` + `<pre>` blocks keep their dark
            // backgrounds in both modes so they read like terminal output.
            <div
              aria-live="polite"
              className="space-y-2 rounded border border-amber-500/60 bg-amber-100/70 p-3 text-sm dark:border-amber-400/50 dark:bg-amber-500/10"
            >
              <p className="font-semibold text-amber-900 dark:text-amber-100">
                You don't have a $FLIP token account yet.
              </p>
              <p className="text-amber-900/90 dark:text-amber-50/90">
                Test $FLIP is mintable on devnet by the test mint authority.
                Send your wallet address{" "}
                <code className="rounded bg-amber-950/80 px-1 py-0.5 font-mono text-amber-50 text-xs dark:bg-black/40">
                  {publicKeyBase58}
                </code>{" "}
                to the maintainer and ask them to run:
              </p>
              <pre className="overflow-x-auto rounded bg-amber-950/90 p-2 font-mono text-amber-50 text-xs dark:bg-black/50">
                {`pnpm --filter @pushflip/scripts mint-test-flip \\\n  --to ${publicKeyBase58}`}
              </pre>
              <p className="text-amber-900/80 text-xs dark:text-amber-100/70">
                A self-service in-app faucet is tracked as a Phase 4 task — see
                EXECUTION_PLAN.md.
              </p>
            </div>
          ) : (
            formError &&
            formError !== "no-ata" && (
              <p
                aria-live="polite"
                className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive text-sm"
              >
                {formError}
              </p>
            )
          )}
        </div>

        <DialogFooter>
          <Button onClick={() => handleOpenChange(false)} variant="ghost">
            Cancel
          </Button>
          <Button disabled={submitDisabled} onClick={handleSubmit}>
            {isPending ? "Confirming…" : "Join"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
