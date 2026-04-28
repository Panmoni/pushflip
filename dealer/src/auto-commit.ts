/**
 * Auto-commit poll loop — pure, dependency-injected core extracted
 * from `service.ts`.
 *
 * The full Decision #2 design rationale lives in
 * `docs/wiki/operations/dealer-runbook.md`. This module isolates the
 * state-machine half (when does the dealer auto-commit a deck?) from
 * the I/O half (which RPC, which keypair, which `Dealer` instance) so
 * the state machine can be unit-tested without standing up a Solana
 * RPC, a keypair, or the snarkjs prover.
 *
 * Heavy-duty review #19 (2026-04-28) caught two state-machine bugs in
 * the inline-closure version:
 *   - **H1**: reset branch fired on `!roundActive` alone, wiping the
 *     local Merkle tree between commit_deck and start_round (which
 *     both have `roundActive=false` on chain).
 *   - **H2**: `commitInFlight` mutex was checked at function top but
 *     set ~30 lines later, so two `setInterval` ticks could pass the
 *     check while one was mid-`fetchSnapshot()` and reach
 *     `commitDeck()` in parallel.
 *
 * Both fixes are now the structural shape of `runAutoCommitTick`
 * (mutex set BEFORE the first await; reset gated on `!roundActive &&
 * !deckCommitted`). The companion test file
 * `auto-commit.test.ts` regression-locks both behaviors plus the
 * surrounding guard set.
 */

/** Floor for triggering auto-commit. join_round at this count → commit_deck. */
export const MIN_PLAYERS_TO_COMMIT = 2;

/** Interval between GameSession polls. 5s gives near-real-time response without burning RPC budget. */
export const POLL_INTERVAL_MS = 5_000;

/**
 * Decoded snapshot of the relevant subset of GameSession fields the
 * poll loop needs. Decoupled from the full `GameSession` so a future
 * field addition doesn't churn this signature OR the test fixtures.
 *
 * `deckCommitted` is the H1-fix-load-bearing field: along with
 * `roundActive` it lets the loop distinguish "round committed
 * waiting for start_round" (`!roundActive && deckCommitted`) from
 * "round ended" (`!roundActive && !deckCommitted`). Resetting the
 * local dealer in the first case would wipe the Merkle tree right
 * after commit_deck.
 */
export interface RoundSnapshot {
  roundActive: boolean;
  deckCommitted: boolean;
  roundNumber: bigint;
  /** Number of seats currently occupied (`player_count` from the on-chain account). */
  activePlayerCount: number;
}

/**
 * The mutable state the tick reads + writes. In production this is
 * a slice of `DealerContext`; in tests it's a fresh object each
 * test creates so mutations don't bleed between cases.
 */
export interface AutoCommitState {
  /** The on-chain `round_number` this dealer's current deck was committed for. */
  committedRoundNumber: bigint | null;
  /**
   * Mutex flag. Claimed BEFORE the first `await` so two `setInterval`
   * ticks cannot both pass the entry check while one is mid-fetch
   * (review #19 H2). Released in `finally` so all early-returns also
   * release.
   */
  commitInFlight: boolean;
}

/**
 * Injected I/O surface. Production wiring (in `service.ts`) glues
 * these to the real RPC, the real `Dealer` instance, and the real
 * `commitDeckForGame` helper. Tests pass `mock.fn()` doubles.
 *
 * Logging is split into three channels mirroring `console.log` /
 * `console.warn` / `console.error` so the production wrapper can
 * apply the `[dealer]` prefix uniformly while tests can assert
 * specific message bodies. All three are optional; tick is silent
 * if they're undefined.
 */
export interface AutoCommitTickDeps {
  fetchSnapshot: () => Promise<RoundSnapshot | null>;
  commitDeck: () => Promise<{ signature: string }>;
  isRoundActive: () => boolean;
  resetDealer: () => void;
  minPlayersToCommit: number;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  errorLog?: (line: string) => void;
}

/**
 * One iteration of the auto-commit poll loop. Pure relative to its
 * injected deps; mutates only `state`.
 *
 * Trigger conditions (all must hold) for emitting a `commitDeck()`:
 *   - GameSession exists on chain.
 *   - `!round_active` (no live round).
 *   - `!deck_committed` (no prior unbroken commit waiting).
 *   - `active_player_count >= deps.minPlayersToCommit`.
 *   - The dealer hasn't already committed for this `round_number`
 *     (avoids double-commit if the poll fires while the previous
 *     commit is still confirming).
 *   - `state.commitInFlight === false` at entry (mutex).
 */
export async function runAutoCommitTick(
  state: AutoCommitState,
  deps: AutoCommitTickDeps,
): Promise<void> {
  // Mutex MUST be claimed before any `await` — otherwise a second
  // setInterval tick can pass this same check while the first tick
  // is still awaiting `fetchSnapshot`, and both would reach the
  // commit path in parallel. dealer.shuffle() mutates instance state
  // (`merkleTree`, `serializedProof`), so two concurrent shuffles
  // would corrupt each other and the on-chain `commit_deck` would
  // reject the second once `deck_committed=true`.
  if (state.commitInFlight) {
    return;
  }
  state.commitInFlight = true;
  try {
    if (deps.isRoundActive()) {
      // Local dealer state already says we're mid-round. Three
      // off-chain states are possible:
      //   1. committed-waiting-for-start: deckCommitted=true,
      //      roundActive=false. start_round hasn't run yet.
      //      Local tree is still load-bearing — DO NOT reset.
      //   2. round-active: roundActive=true. Stay parked.
      //   3. round-ended: deckCommitted=false, roundActive=false.
      //      end_round cleared both flags. Local tree is stale —
      //      reset so the next round can commit.
      // Distinguishing (1) from (3) requires reading `deckCommitted`,
      // not just `roundActive` (review #19 H1).
      let gs: RoundSnapshot | null;
      try {
        gs = await deps.fetchSnapshot();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        deps.warn?.(`poll: re-entry GameSession fetch failed: ${msg}`);
        return;
      }
      if (gs && !gs.roundActive && !gs.deckCommitted) {
        deps.log?.(
          `round ${state.committedRoundNumber} ended on chain — resetting dealer for next round`,
        );
        deps.resetDealer();
        state.committedRoundNumber = null;
      }
      return;
    }

    let gs: RoundSnapshot | null;
    try {
      gs = await deps.fetchSnapshot();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.warn?.(`poll: GameSession fetch failed: ${msg}`);
      return;
    }
    if (gs === null) {
      // Game not initialized yet; quietly try again next tick.
      return;
    }
    if (gs.roundActive) {
      // Race: chain says active, our local Dealer says no round.
      // Cards already dealt are unrecoverable — wait for the round
      // to end.
      return;
    }
    if (gs.deckCommitted) {
      // Chain says deck is committed (by us or a prior dealer
      // instance) but local state is empty. Can't serve reveals
      // against a Merkle root we no longer have. Wait for end_round.
      return;
    }
    if (gs.activePlayerCount < deps.minPlayersToCommit) {
      return;
    }
    // Avoid re-committing for the same round_number. The on-chain
    // round_number doesn't increment until end_round runs, so check
    // strict-equality (rather than `>`) to handle the post-end_round
    // case where the next round shares the prior counter momentarily.
    if (
      state.committedRoundNumber !== null &&
      gs.roundNumber === state.committedRoundNumber
    ) {
      return;
    }

    try {
      deps.log?.(
        `auto-commit triggered — round=${gs.roundNumber} players=${gs.activePlayerCount}`,
      );
      const result = await deps.commitDeck();
      state.committedRoundNumber = gs.roundNumber;
      deps.log?.(
        `auto-commit OK — round=${gs.roundNumber} sig=${result.signature}`,
      );
    } catch (e) {
      deps.resetDealer();
      const msg = e instanceof Error ? e.message : String(e);
      deps.errorLog?.(
        `auto-commit failed round ${gs.roundNumber}: ${msg}`,
      );
    }
  } finally {
    state.commitInFlight = false;
  }
}

/**
 * Production wiring for the tick. `setInterval` fires the tick
 * every `intervalMs`; if a tick takes longer than that (proof
 * generation can be ~30s), the `commitInFlight` mutex no-ops the
 * overlapping invocations.
 */
export function startAutoCommitLoop(
  state: AutoCommitState,
  deps: AutoCommitTickDeps,
  intervalMs: number = POLL_INTERVAL_MS,
): NodeJS.Timeout {
  return setInterval(() => {
    runAutoCommitTick(state, deps).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      deps.errorLog?.(`poll tick error: ${msg}`);
    });
  }, intervalMs);
}
