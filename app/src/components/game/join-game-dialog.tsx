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

import { MIN_STAKE } from "@pushflip/client";
import { useState } from "react";

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
import { FLIP_SCALE, formatFlip, parseU64, U64_MAX } from "@/lib/flip-format";
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
 * validation. Uses `parseU64` from `@/lib/flip-format` for the
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

  const balanceQuery = useTokenBalance();
  const { joinRound, isPending } = useGameActions();

  const balance = balanceQuery.data?.balance ?? null;
  const balanceLoading = balanceQuery.isLoading;
  const parsed = parseStakeInput(rawStake);

  // Three layered errors, checked in order so the user sees the most
  // actionable one first:
  //  1. Parse error (malformed input)
  //  2. No-ATA error (wallet has no $FLIP token account at all — must
  //     receive test FLIP before joining; the on-chain join would
  //     otherwise fail with a confusing "account does not exist")
  //  3. Insufficient-balance error (has an ATA but not enough $FLIP)
  let formError: string | null = parsed.error;
  if (formError === null && parsed.ok && !balanceLoading) {
    if (balance === null) {
      formError =
        "You don't have a $FLIP token account yet. Receive some test $FLIP first, then try again.";
    } else if (parsed.stakeBaseUnits > balance) {
      formError = `Insufficient balance — wallet has ${formatFlip(balance)} $FLIP`;
    }
  }

  // Submit is disabled if: parse failed, any layered form error fires,
  // a join is in flight, OR the balance query is still loading (we
  // can't reliably check sufficiency until balance resolves).
  const submitDisabled =
    !parsed.ok || formError !== null || isPending || balanceLoading;

  function handleSubmit() {
    if (!parsed.ok) {
      return;
    }
    joinRound(parsed.stakeBaseUnits)
      .then(() => {
        setOpen(false);
      })
      .catch(() => {
        // No-op — `useGameActions.runAction` already raises a toast on
        // failure (use-game-actions.ts:158). Raising another one here
        // would double-report the same error. The dialog stays open
        // so the user can adjust the stake and retry.
      });
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
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
                formError && "border-destructive focus:ring-destructive/40"
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

          {formError && (
            <p
              aria-live="polite"
              className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive text-sm"
            >
              {formError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button onClick={() => setOpen(false)} variant="ghost">
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
