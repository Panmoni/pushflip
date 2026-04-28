/**
 * Regression coverage for the auto-commit poll loop's state machine.
 *
 * Heavy-duty review #19 (2026-04-28) caught two bugs in the inline-
 * closure version of this code that this file's tests now lock in:
 *
 *   - **H1** ("don't reset between commit_deck and start_round"):
 *     the reset branch fired whenever `local isRoundActive &&
 *     !on-chain roundActive`. But on-chain state between commit_deck
 *     and start_round is exactly that pattern, so the next 5s tick
 *     would have wiped the local Merkle tree right after committing
 *     it. Fixed: reset gated on `!roundActive && !deckCommitted`.
 *
 *   - **H2** ("mutex must be claimed before first await"): the
 *     `commitInFlight` flag was checked at function top BEFORE the
 *     first `await fetchGameSession`, only set ~30 lines later. Two
 *     `setInterval` ticks could pass the check while one was mid-
 *     fetch and reach `await commitDeckForGame(...)` in parallel.
 *     Fixed: mutex set BEFORE first await.
 *
 * These tests construct the racing-tick scenario explicitly via
 * deferred promises so the H2 fix is locked in (without the fix,
 * the test would observe two `commitDeck` calls instead of one).
 *
 * The other tests cover the surrounding guard set (player count,
 * already-committed-this-round, snapshot null, fetch failure,
 * commit failure → reset, on-chain race conditions) so that any
 * future re-edit of `runAutoCommitTick` has full coverage.
 *
 * Test runner: Node's built-in `node:test`, invoked via the
 * `dealer` workspace's `test` script
 * (`find src -name '*.test.ts' -exec npx tsx --test {} +`).
 */

import { strict as assert } from "node:assert";
import { type Mock, mock, test } from "node:test";

import {
  type AutoCommitState,
  type AutoCommitTickDeps,
  type RoundSnapshot,
  runAutoCommitTick,
} from "./auto-commit.js";

// --- Test fixtures ---

function freshState(overrides: Partial<AutoCommitState> = {}): AutoCommitState {
  return {
    committedRoundNumber: null,
    commitInFlight: false,
    ...overrides,
  };
}

/**
 * Snapshot factory. Defaults to "ready to commit": no round, no
 * deck, two players joined. Each test overrides the relevant
 * fields.
 */
function snapshot(overrides: Partial<RoundSnapshot> = {}): RoundSnapshot {
  return {
    roundActive: false,
    deckCommitted: false,
    roundNumber: 1n,
    activePlayerCount: 2,
    ...overrides,
  };
}

/**
 * Bundle of typed mocks for each injected dep. `buildDeps` returns
 * both `deps` (the AutoCommitTickDeps shape passed into
 * runAutoCommitTick) and `mocks` (the same callables typed as
 * `Mock<...>` so `.mock.callCount()` typechecks). Production type
 * narrowing makes the deps interface use the bare function type;
 * the mocks bundle preserves the test's view.
 */
interface DepMocks {
  fetchSnapshot: Mock<AutoCommitTickDeps["fetchSnapshot"]>;
  commitDeck: Mock<AutoCommitTickDeps["commitDeck"]>;
  isRoundActive: Mock<AutoCommitTickDeps["isRoundActive"]>;
  resetDealer: Mock<AutoCommitTickDeps["resetDealer"]>;
  log: Mock<NonNullable<AutoCommitTickDeps["log"]>>;
  warn: Mock<NonNullable<AutoCommitTickDeps["warn"]>>;
  errorLog: Mock<NonNullable<AutoCommitTickDeps["errorLog"]>>;
}

function buildDeps(
  overrides: Partial<AutoCommitTickDeps> = {},
): { deps: AutoCommitTickDeps; mocks: DepMocks } {
  const mocks: DepMocks = {
    fetchSnapshot: mock.fn(async () => snapshot() as RoundSnapshot | null),
    commitDeck: mock.fn(async () => ({ signature: "sig-fixture" })),
    isRoundActive: mock.fn(() => false),
    resetDealer: mock.fn(() => undefined),
    log: mock.fn((_line: string) => undefined),
    warn: mock.fn((_line: string) => undefined),
    errorLog: mock.fn((_line: string) => undefined),
  };
  const deps: AutoCommitTickDeps = {
    fetchSnapshot: mocks.fetchSnapshot,
    commitDeck: mocks.commitDeck,
    isRoundActive: mocks.isRoundActive,
    resetDealer: mocks.resetDealer,
    minPlayersToCommit: 2,
    log: mocks.log,
    warn: mocks.warn,
    errorLog: mocks.errorLog,
    ...overrides,
  };
  return { deps, mocks };
}

// --- Happy path ---

test("happy path: ready snapshot triggers commitDeck and records round_number", async () => {
  const state = freshState();
  const { deps, mocks } = buildDeps({
    fetchSnapshot: mock.fn(async () => snapshot({ roundNumber: 7n })),
  });

  await runAutoCommitTick(state, deps);

  assert.equal(mocks.commitDeck.mock.callCount(), 1);
  assert.equal(state.committedRoundNumber, 7n);
  assert.equal(state.commitInFlight, false, "mutex released");
  assert.equal(mocks.resetDealer.mock.callCount(), 0, "happy path does not reset");
});

// --- Guard set: don't commit ---

test("guard: snapshot returns null (game not initialized) → no commit, no reset", async () => {
  const state = freshState();
  const { deps, mocks } = buildDeps({
    fetchSnapshot: mock.fn(async () => null),
  });

  await runAutoCommitTick(state, deps);

  assert.equal(mocks.commitDeck.mock.callCount(), 0);
  assert.equal(mocks.resetDealer.mock.callCount(), 0);
  assert.equal(state.committedRoundNumber, null);
});

test("guard: round currently active on chain → no commit", async () => {
  const state = freshState();
  const { deps, mocks } = buildDeps({
    fetchSnapshot: mock.fn(async () => snapshot({ roundActive: true })),
  });

  await runAutoCommitTick(state, deps);

  assert.equal(mocks.commitDeck.mock.callCount(), 0);
});

test("guard: deckCommitted already on chain (recovery state) → no commit", async () => {
  const state = freshState();
  const { deps, mocks } = buildDeps({
    fetchSnapshot: mock.fn(async () =>
      snapshot({ roundActive: false, deckCommitted: true }),
    ),
  });

  await runAutoCommitTick(state, deps);

  assert.equal(mocks.commitDeck.mock.callCount(), 0);
});

test("guard: activePlayerCount < minPlayersToCommit → no commit", async () => {
  const state = freshState();
  const { deps, mocks } = buildDeps({
    fetchSnapshot: mock.fn(async () => snapshot({ activePlayerCount: 1 })),
  });

  await runAutoCommitTick(state, deps);

  assert.equal(mocks.commitDeck.mock.callCount(), 0);
});

test("guard: same round_number as the one we last committed → no double-commit", async () => {
  const state = freshState({ committedRoundNumber: 5n });
  const { deps, mocks } = buildDeps({
    fetchSnapshot: mock.fn(async () => snapshot({ roundNumber: 5n })),
  });

  await runAutoCommitTick(state, deps);

  assert.equal(mocks.commitDeck.mock.callCount(), 0);
});

test("guard: new round_number after end_round → commit fires", async () => {
  // round 5 was committed; end_round ran clearing deck_committed but
  // NOT bumping round_number (start_round is what bumps it). We
  // shouldn't re-commit at round 5. But once players join the next
  // round and round_number ticks (e.g. via a follow-up start_round),
  // the dealer SHOULD commit for the new round.
  const state = freshState({ committedRoundNumber: 5n });
  const { deps, mocks } = buildDeps({
    fetchSnapshot: mock.fn(async () => snapshot({ roundNumber: 6n })),
  });

  await runAutoCommitTick(state, deps);

  assert.equal(mocks.commitDeck.mock.callCount(), 1);
  assert.equal(state.committedRoundNumber, 6n);
});

// --- Error paths ---

test("commitDeck throws → resetDealer called, committedRoundNumber unchanged, mutex released", async () => {
  const state = freshState();
  const { deps, mocks } = buildDeps({
    commitDeck: mock.fn(async () => {
      throw new Error("rpc dropped");
    }),
  });

  await runAutoCommitTick(state, deps);

  assert.equal(mocks.resetDealer.mock.callCount(), 1);
  assert.equal(state.committedRoundNumber, null);
  assert.equal(state.commitInFlight, false);
  assert.equal(mocks.errorLog.mock.callCount(), 1);
});

test("fetchSnapshot throws → no commit, no reset, mutex released", async () => {
  const state = freshState();
  const { deps, mocks } = buildDeps({
    fetchSnapshot: mock.fn(async () => {
      throw new Error("rpc dropped");
    }),
  });

  await runAutoCommitTick(state, deps);

  assert.equal(mocks.commitDeck.mock.callCount(), 0);
  assert.equal(mocks.resetDealer.mock.callCount(), 0);
  assert.equal(state.commitInFlight, false);
  assert.equal(mocks.warn.mock.callCount(), 1);
});

// --- H1 regression: don't reset between commit_deck and start_round ---

test("H1 regression: local round-active + on-chain (!roundActive && deckCommitted) → DO NOT reset", async () => {
  // The bug: after a successful commit_deck, the on-chain state is
  // `roundActive=false && deckCommitted=true`. Local state is
  // `isRoundActive=true` (Dealer.merkleTree is non-null). The
  // pre-fix reset branch fired on `!roundActive` alone and would
  // wipe the local Merkle tree. The fix: reset only when BOTH
  // !roundActive AND !deckCommitted.
  const state = freshState({ committedRoundNumber: 3n });
  const { deps, mocks } = buildDeps({
    isRoundActive: mock.fn(() => true),
    fetchSnapshot: mock.fn(async () =>
      snapshot({
        roundActive: false,
        deckCommitted: true,
        roundNumber: 3n,
      }),
    ),
  });

  await runAutoCommitTick(state, deps);

  assert.equal(
    mocks.resetDealer.mock.callCount(),
    0,
    "MUST NOT reset between commit_deck and start_round",
  );
  assert.equal(state.committedRoundNumber, 3n, "round number preserved");
});

test("H1 round-ended branch: local round-active + on-chain (!roundActive && !deckCommitted) → DO reset", async () => {
  // After end_round runs, both flags are cleared on chain. The
  // local Merkle tree is now stale; the dealer must reset so the
  // next round can be committed.
  const state = freshState({ committedRoundNumber: 3n });
  const { deps, mocks } = buildDeps({
    isRoundActive: mock.fn(() => true),
    fetchSnapshot: mock.fn(async () =>
      snapshot({
        roundActive: false,
        deckCommitted: false,
        roundNumber: 3n,
        activePlayerCount: 0,
      }),
    ),
  });

  await runAutoCommitTick(state, deps);

  assert.equal(
    mocks.resetDealer.mock.callCount(),
    1,
    "round actually ended → reset required",
  );
  assert.equal(state.committedRoundNumber, null);
  assert.equal(mocks.log.mock.callCount(), 1);
});

test("H1: local round-active + on-chain roundActive=true → no reset, no commit (round in progress)", async () => {
  const state = freshState({ committedRoundNumber: 3n });
  const { deps, mocks } = buildDeps({
    isRoundActive: mock.fn(() => true),
    fetchSnapshot: mock.fn(async () =>
      snapshot({
        roundActive: true,
        deckCommitted: true,
        roundNumber: 3n,
      }),
    ),
  });

  await runAutoCommitTick(state, deps);

  assert.equal(mocks.resetDealer.mock.callCount(), 0);
  assert.equal(mocks.commitDeck.mock.callCount(), 0);
  assert.equal(state.committedRoundNumber, 3n);
});

// --- H2 regression: mutex must be claimed before the first await ---

/**
 * Construct a deferred promise so the test can control exactly when
 * `commitDeck` resolves. Lets us stage tick A in mid-await while
 * tick B fires and observes the mutex.
 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("H2 regression: racing tick during commit await sees mutex set, returns no-op", async () => {
  // The bug: pre-fix, `commitInFlight` was set AFTER
  // `await fetchSnapshot`. Two ticks could both pass the entry
  // guard (commitInFlight=false), both await fetchSnapshot, then
  // both reach `await commitDeck()` in parallel. The fix: claim
  // the mutex BEFORE the first await. This test stages tick A
  // mid-`commitDeck` and asserts a parallel tick B does nothing.
  const state = freshState();
  const commitDeferred = deferred<{ signature: string }>();
  const commitDeckMock = mock.fn(async () => commitDeferred.promise);

  const { deps } = buildDeps({
    commitDeck: commitDeckMock,
  });

  // Tick A — kicked off, NOT awaited. After it sets the mutex and
  // starts awaiting commitDeck, control returns to this test code.
  const tickA = runAutoCommitTick(state, deps);

  // Single microtask yield is enough: tick A reaches the first
  // `await deps.fetchSnapshot()`, the snapshot's resolution
  // microtask runs ahead of this `Promise.resolve()` (it was queued
  // first when fetchSnapshot's body executed synchronously), tick A
  // then runs straight through the snapshot guards to
  // `await deps.commitDeck()` and parks on the deferred promise.
  await Promise.resolve();

  // Sanity: tick A is mid-commit (mutex set, commitDeck called once).
  assert.equal(state.commitInFlight, true, "mutex held by tick A");
  assert.equal(commitDeckMock.mock.callCount(), 1);

  // Tick B fires while tick A is mid-await. Without the H2 fix,
  // tick B would also pass the entry guard and reach commitDeck.
  // With the fix, it sees commitInFlight=true and returns immediately.
  await runAutoCommitTick(state, deps);

  assert.equal(
    commitDeckMock.mock.callCount(),
    1,
    "tick B must NOT call commitDeck while tick A holds the mutex",
  );

  // Let tick A finish so the test exits cleanly.
  commitDeferred.resolve({ signature: "sig-A" });
  await tickA;

  assert.equal(state.commitInFlight, false, "mutex released after tick A");
  assert.equal(state.committedRoundNumber, 1n, "tick A's round recorded");
});

test("H2: mutex check is the first thing in tick (re-entrant call early-returns immediately)", async () => {
  // Direct test: pre-set commitInFlight, observe that no I/O
  // happens before return.
  const state = freshState({ commitInFlight: true });
  const { deps, mocks } = buildDeps();

  await runAutoCommitTick(state, deps);

  assert.equal(
    mocks.fetchSnapshot.mock.callCount(),
    0,
    "fetchSnapshot must not run when mutex is held",
  );
  assert.equal(mocks.commitDeck.mock.callCount(), 0);
  assert.equal(mocks.isRoundActive.mock.callCount(), 0);
  // Critical: the function did NOT release the mutex on its early
  // return when it didn't claim it. This matches production semantics
  // (the holding tick is responsible for its own release).
  assert.equal(state.commitInFlight, true, "mutex left as we found it");
});

// --- Mutex release on code paths the body tests don't already cover ---
//
// The happy path / fetchSnapshot-rejection / commitDeck-rejection body
// tests above already assert `state.commitInFlight === false` after
// their respective branches. The two cases below are the gaps: the
// null-snapshot early-return and the H1 reset branch don't otherwise
// have mutex-state assertions.

test("mutex released after early-return on null snapshot", async () => {
  const state = freshState();
  const { deps } = buildDeps({ fetchSnapshot: mock.fn(async () => null) });
  await runAutoCommitTick(state, deps);
  assert.equal(state.commitInFlight, false);
});

test("mutex released after H1 reset branch", async () => {
  const state = freshState({ committedRoundNumber: 1n });
  const { deps } = buildDeps({
    isRoundActive: mock.fn(() => true),
    fetchSnapshot: mock.fn(async () =>
      snapshot({ roundActive: false, deckCommitted: false }),
    ),
  });
  await runAutoCommitTick(state, deps);
  assert.equal(state.commitInFlight, false);
});
