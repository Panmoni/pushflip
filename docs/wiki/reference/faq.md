---
title: FAQ
diataxis_type: explanation
last_compiled: 2026-04-11
---

# PushFlip — FAQ

If you want the user-facing pitch first, read [README.md](../../../README.md). If
you want the full task-by-task history with lessons learned, read
[docs/EXECUTION_PLAN.md](../../EXECUTION_PLAN.md). This document is for the
*technical* questions those two don't directly answer.

## Table of Contents

**Part 1 — Curious / Neutral**

1. [Walk me through what this program actually does in 11 instructions.](#q1)
2. [What does the ZK proof actually prove? Walk me through the deck commitment scheme end-to-end.](#q2)
3. [Why Pinocchio over Anchor? What did you actually give up?](#q3)
4. [How is the on-chain Poseidon hash computed?](#q4)
5. [What's the testing pyramid? Where are the seams?](#q5)
6. [Show me how you validate accounts without `#[derive(Accounts)]`.](#q6)
7. [How do you keep the TypeScript client honest with the on-chain account layout when there's no IDL?](#q7)
8. [What does a full 4-player game cost on Solana, and where does the time go?](#q8)

**Part 2 — Probing / Critical**

9. [Why not Switchboard VRF? Isn't this all just a fancier oracle dance?](#q9)
10. [Single trusted dealer. Call it what it is. Why isn't this just a fancier "trust me bro"?](#q10)
11. [Hand-rolled byte layouts and zero-copy without Anchor's safety nets. How do you guarantee you won't ship a misaligned read or a forgotten owner check?](#q11)
12. [Pinocchio's `try_borrow_mut()` doesn't enforce `is_writable`. How many similar landmines are still in this code?](#q12)
13. [Groth16 verification at ~85K CU sounds tight. What happens under congestion?](#q13)
14. [snarkjs G2 byte order vs alt_bn128 nearly shipped a broken verifier. What's stopping the next subtle crypto serialization bug?](#q14)
15. [Did you actually run a trusted setup ceremony? What ptau file are you using?](#q15)
16. [Tests pass under LiteSVM but devnet revealed an 11 KB stack overflow. How is your test suite still trustworthy after that?](#q16)
17. [What would actually need to happen for this to ship to mainnet?](#q17)

---

## Part 1 — Curious / Neutral

### <a id="q1"></a>Q1. Walk me through what this program actually does in 11 instructions.

The program is a single-binary card game with 11 instruction handlers,
dispatched on the first byte of `instruction_data`. The entrypoint is at
[program/src/lib.rs:17](../../../program/src/lib.rs#L17) using
`program_entrypoint!` (the eager parser, not `lazy_program_entrypoint!`),
and the dispatch table is the `match` block at
[program/src/lib.rs:28-41](../../../program/src/lib.rs#L28-L41).

The 11 instructions, in dispatch order:

| # | Instruction | What it does |
|---|---|---|
| 0 | `initialize` | Creates a `GameSession` PDA at `["game", game_id.to_le_bytes()]`, stores authority/dealer/treasury/token_mint/vault_bump |
| 1 | `commit_deck` | Verifies the dealer's Groth16 shuffle proof and stores the Merkle root |
| 2 | `join_round` | Creates a `PlayerState` PDA, optionally CPI-transfers stake to the vault |
| 3 | `start_round` | Locks the player set, flips `round_active=true`, sets turn index 0 |
| 4 | `hit` | Verifies a Poseidon Merkle proof for one card, appends to hand, checks bust, applies protocol-card effects |
| 5 | `stay` | Player locks score, turn advances |
| 6 | `end_round` | Determines winner, distributes pot minus 2% rake |
| 7 | `close_game` | Closes the GameSession PDA, returns rent (only when `pot=0` and round inactive) |
| 8 | `leave_game` | Pre-round: removes from turn order. Mid-round: forfeits as bust |
| 9 | `burn_second_chance` | Burns 50 $FLIP via SPL CPI, undoes the player's bust |
| 10 | `burn_scry` | Burns 25 $FLIP via SPL CPI, lets player peek the next card off-chain |

State lives in three PDA types: `GameSession` (512 B,
[program/src/state/game_session.rs](../../../program/src/state/game_session.rs)),
`PlayerState` (256 B,
[program/src/state/player_state.rs](../../../program/src/state/player_state.rs)),
and a vault SPL token account at `["vault", game_session_pda]`. The
typical session is `initialize → join_round × N → commit_deck →
start_round → (hit | stay) loop → end_round → close_game`. Both
`GameSession` and `PlayerState` use a manual zero-copy layout — explicit
byte offsets at the top of each file, accessor methods that read from
those offsets, and a `from_bytes()` constructor that asserts a minimum
length so all subsequent reads are bounds-safe.

The deployed program ID is `HQLeAQc84WLz8buHM5JAJGBjNJjwc6Fpxts8jSMaW3px`
on devnet, declared at
[program/src/lib.rs:13](../../../program/src/lib.rs#L13).

### <a id="q2"></a>Q2. What does the ZK proof actually prove? Walk me through the deck commitment scheme end-to-end.

The proof is a Groth16 SNARK over a Circom circuit that proves: *given a
public Merkle root, I know a private permutation of the canonical 94-card
deck whose Poseidon Merkle root matches that public root.* In other
words, it proves the committed deck is a *valid permutation* — no
duplicates, no missing cards, no slipped-in extras — without revealing
the order. It does **not** prove the permutation is random. Hold that
distinction; it returns in [Q10](#q10).

The pipeline:

1. **Off-chain (dealer).** The dealer in
   [dealer/src/](../../../dealer/src/) shuffles the canonical deck with a
   Fisher-Yates pass, builds a depth-7 Poseidon Merkle tree (128 leaves =
   94 real cards + 34 padding leaves), then runs snarkjs to generate a
   Groth16 proof against the `shuffle_verify` circuit
   ([zk-circuits/circuits/shuffle_verify.circom](../../../zk-circuits/circuits/shuffle_verify.circom)).
   The circuit asserts a grand-product permutation argument plus per-card
   range checks. The output is a Merkle root + a 256-byte proof
   (`(proof_a, proof_b, proof_c)` = 64 + 128 + 64 bytes).

2. **On-chain (commit phase).** The dealer sends `commit_deck`. The
   handler at
   [program/src/instructions/commit_deck.rs](../../../program/src/instructions/commit_deck.rs)
   verifies `dealer == game_session.dealer`, refuses if the round is
   already active or the deck is already committed, then calls
   `verify_shuffle_proof`
   ([program/src/zk/groth16.rs](../../../program/src/zk/groth16.rs)) which
   wraps `pinocchio_groth16::Groth16Verifier`. Public inputs are
   `[merkle_root, CANONICAL_DECK_HASH]`. The canonical deck hash is a
   precomputed Poseidon chain hash of the canonical deck, baked in at
   [program/src/zk/verifying_key.rs:21-24](../../../program/src/zk/verifying_key.rs#L21-L24).
   On success the Merkle root is stored on-chain, `deck_committed` is
   flipped, and `draw_counter` is reset. Measured cost: **84,834 CU**
   total (alt_bn128 syscalls included).

3. **On-chain (reveal phase).** Each `hit` instruction
   ([program/src/instructions/hit.rs](../../../program/src/instructions/hit.rs))
   carries `(card_value, card_type, card_suit, leaf_index, proof[7×32])`.
   The handler enforces `leaf_index == draw_counter` (no skipping ahead,
   no replays), then calls
   [program/src/zk/merkle.rs:22](../../../program/src/zk/merkle.rs#L22)
   which Poseidons the leaf, walks up 7 levels with the supplied
   siblings, and compares the recomputed root to the stored one.
   Measured cost: **7,771 CU** end-to-end.

The README has the same pipeline drawn as a diagram in the
[How the ZK System Works](../../../README.md#how-the-zk-system-works) section,
and [docs/ZK_RESEARCH.md](zk-research.md) is the long-form write-up of
why this stack was chosen over Halo2/STARKs/SP1.

### <a id="q3"></a>Q3. Why Pinocchio over Anchor? What did you actually give up?

Pinocchio is Anza's zero-dependency native-Rust framework. There is no
`#[program]` attribute, no `#[derive(Accounts)]`, no automatic
discriminators, no automatic IDL, no automatic client. You get an
entrypoint macro and a slice of `AccountView`. Everything else you build
yourself. The trade made sense for this project for three reasons:

**Compute-unit efficiency.** SPL Token operations through Pinocchio's
`pinocchio_token` are roughly an order of magnitude cheaper than the same
operations through Anchor's wrappers. The whole project's hot-path budget
(`hit` at 7,771 CU, `commit_deck` at 84,834 CU) only fits because nothing
in the dispatch path pays Anchor's deserialization tax.

**Zero-copy is the default, not an optimization.** The state structs at
[program/src/state/game_session.rs:10-33](../../../program/src/state/game_session.rs#L10-L33)
are explicit byte offsets, not Borsh-derived structs. You read the bytes
in place; you write the bytes in place. No allocator, no
serialize/deserialize round-trip. This is the same model the Solana
runtime uses internally and it eliminates an entire bug class around
re-serialization mismatches.

**Portfolio differentiation.** Anchor is the table-stakes Solana
framework now. Building a non-trivial program directly on Pinocchio
demonstrates exactly the internals knowledge a senior reviewer is looking
for: how the runtime actually passes accounts, how PDAs are derived,
what `try_borrow_mut` actually does (see [Q12](#q12) for what it does
*not* do), and how to call the alt_bn128 and Poseidon syscalls without
an SDK in between.

What you give up is honest:

- `#[derive(Accounts)]` ergonomics — every handler now has 20+ lines of
  `verify_account_owner` / `verify_writable` / `verify_signer` / PDA
  re-derivation calls. You see the validation, but you also have to
  *write* the validation. See [Q6](#q6) for the pattern.
- The Anchor IDL pipeline — there is no `target/idl/pushflip.json`. The
  TypeScript client is hand-written ([Q7](#q7)).
- Anchor's safety defaults — the `is_writable` check that Anchor does
  for free at deserialization time has to be done by hand. The
  consequence of getting that wrong is documented in [Q12](#q12).
- A familiar testing story — you don't get `anchor test`. You get
  LiteSVM, a build.rs that has to isolate the test SBF binary from the
  deploy SBF binary, and a devnet smoke test as a regression guard.
  See [Q5](#q5).

[docs/PINOCCHIO_RESOURCE_GUIDE.md](pinocchio-guide.md) is the
in-repo distillation of every Pinocchio gotcha discovered along the way.

### <a id="q4"></a>Q4. How is the on-chain Poseidon hash computed?

The on-chain Poseidon hash goes through Solana's native `sol_poseidon`
syscall via a thin `extern "C"` wrapper at
[program/src/zk/poseidon_native.rs](../../../program/src/zk/poseidon_native.rs).
The wrapper is conditionally compiled — `#[cfg(target_os = "solana")]`
calls the syscall directly, `#[cfg(not(target_os = "solana"))]` falls
back to the `light_poseidon` crate for host-side `cargo test`
cross-validation. The deployed BPF binary contains zero
`light_poseidon` code.

The original implementation called `light_poseidon` directly. The
function `light_poseidon::parameters::bn254_x5::get_poseidon_parameters`
allocates ~200 BN254 field elements as locals; the Rust compiler sums
those into one stack frame ~11 KB wide. The Solana BPF runtime has a
hard 4 KB stack limit per function call, so the program is unsound on
BPF the moment that function is reached. LiteSVM runs the program on
the host CPU, not BPF, so the host-allocated stack absorbed the
overflow and the LiteSVM suite was green. The first devnet call
against a real validator crashed at 211,142 CU with `Access violation
in stack frame 5`. The fix replaced the in-program Poseidon
implementation with the syscall, which charges a flat fee and uses zero
of the program's own BPF stack. The same `hit` instruction now consumes
**7,771 CU** — a 27× reduction, plus the elimination of the underlying
soundness issue.

The byte-compatibility argument for the swap is in the doc comment at
[program/src/zk/poseidon_native.rs:16-30](../../../program/src/zk/poseidon_native.rs#L16-L30):
`solana-poseidon-3.1.11`'s host fallback delegates to the same
`light_poseidon::Poseidon::<ark_bn254::Fr>::new_circom(N).hash_bytes_be`
call the program used to make, so the syscall and the host fallback
produce byte-identical output for the BN254-X5 circom variant. The
`test_canonical_deck_hash_matches_js` host test at
[program/src/zk/merkle.rs:193-220](../../../program/src/zk/merkle.rs#L193-L220)
chains the canonical 94-card deck through the wrapper and compares
against `CANONICAL_DECK_HASH`, cross-validating against circomlibjs.

The full retrospective is in
[docs/POSEIDON_STACK_WARNING.md](../history/poseidon-stack-warning.md), and §11 of
[PINOCCHIO_RESOURCE_GUIDE.md](pinocchio-guide.md#11-poseidon-hashing-via-sol_poseidon-syscall)
documents the syscall calling convention in detail. The general lesson
is in [Q16](#q16).

### <a id="q5"></a>Q5. What's the testing pyramid? Where are the seams?

98 tests across four layers, each catching a different bug class:

| Layer | Count | Where | What it catches |
|---|---|---|---|
| Program lib unit tests | 42 | `program/src/**/tests` | Byte-offset round-trips, scoring logic, deck construction, Merkle proof math |
| LiteSVM integration tests | 20 | [tests/src/](../../../tests/src/) (9 Phase 1 + 11 Phase 2) | Full instruction handlers including account validation paths, token CPIs, lifecycle |
| Dealer ZK tests | 11 | [dealer/src/](../../../dealer/src/) (8 merkle + 3 prover G2-swap fixtures) | Merkle tree construction, proof serialization, the G2 byte-order convention |
| TypeScript client tests | 25 | [clients/js/src/client.test.ts](../../../clients/js/src/client.test.ts) | Instruction-builder byte layouts, PDA derivation, account decoders |

Plus the devnet smoke test
([scripts/smoke-test.ts](../../../scripts/smoke-test.ts)) as a fifth layer
that runs the whole stack against `HQLeAQc84WLz8buHM5JAJGBjNJjwc6Fpxts8jSMaW3px`
on real devnet. It's not yet in CI; it's run manually before any change
that touches the ZK or syscall path.

The interesting question is which layer catches which bug. LiteSVM is
fast and ergonomic but it executes the program on the host architecture,
which means *anything that depends on the BPF runtime's actual behaviour
is invisible to it*. That's exactly the seam the Poseidon overflow
slipped through ([Q4](#q4)). The smoke test is the only layer that
exercises the real `sol_poseidon` syscall, the real alt_bn128 syscalls,
real BPF stack frames, and real CU accounting. After Task 2.10, running
it before merging any ZK-touching change is mandatory.

The build script at [tests/build.rs](../../../tests/build.rs) is part of the
testing story — it isolates the test binary into `target/deploy-test/`
with `--features skip-zk-verify`, away from the production
`target/deploy/pushflip.so`, so the two builds can never clobber each
other. That decoupling came out of the same review that surfaced the
borrow-semantics issue in [Q12](#q12).

### <a id="q6"></a>Q6. Show me how you validate accounts without `#[derive(Accounts)]`.

There are three centralized helpers in
[program/src/utils/accounts.rs:6-30](../../../program/src/utils/accounts.rs#L6-L30):

```rust
pub fn verify_account_owner(account: &AccountView, expected: &Address) -> Result<(), ProgramError>
pub fn verify_signer(account: &AccountView) -> Result<(), ProgramError>
pub fn verify_writable(account: &AccountView) -> Result<(), ProgramError>
```

Each handler calls them inline at the top of `process()`. For a concrete
example, `hit` at
[program/src/instructions/hit.rs:70-75](../../../program/src/instructions/hit.rs#L70-L75):

```rust
let owner = pinocchio::Address::new_from_array(ID);
verify_account_owner(game_session, &owner)?;
verify_writable(game_session)?;
verify_account_owner(player_state, &owner)?;
verify_writable(player_state)?;
verify_signer(player)?;
```

After ownership/writability/signer checks, every state read goes through
a discriminator gate — e.g.
[program/src/instructions/hit.rs:84-86](../../../program/src/instructions/hit.rs#L84-L86):

```rust
if gs.discriminator() != GAME_SESSION_DISCRIMINATOR {
    return Err(ProgramError::InvalidAccountData);
}
```

PDAs are validated by re-deriving the address from seeds and comparing
byte-for-byte against the supplied account address (see
[program/src/instructions/initialize.rs](../../../program/src/instructions/initialize.rs)
for the canonical example). Cross-account invariants — the player must
match the current `turn_order` slot, the dealer must match
`game_session.dealer`, the player must own the `PlayerState` account it
is mutating — are checked inline at the call sites.

The honest acknowledgement is that this pattern is fragile *by
construction*. Any new instruction added by a future contributor must
remember to call all three helpers and the discriminator gate, in the
right order, before any borrow. Nothing in the type system enforces it.
The only protections are the centralized helpers (so the *implementation*
of each check lives in one place), the LiteSVM tests covering unhappy
paths, and the four-plus heavy-duty review checkpoints recorded in
[docs/EXECUTION_PLAN.md](../../EXECUTION_PLAN.md) (search for
`heavy-duty-review`). [Q11](#q11) and [Q12](#q12) explore where this
fragility has actually bitten.

### <a id="q7"></a>Q7. How do you keep the TypeScript client honest with the on-chain account layout when there's no IDL?

There is no IDL. The client at
[clients/js/src/](../../../clients/js/src/) is hand-written against the same
byte offsets the Rust struct uses, and the synchronization is enforced
by tests on both sides plus a devnet round-trip.

The Rust account layout in
[program/src/state/game_session.rs:10-33](../../../program/src/state/game_session.rs#L10-L33)
is the source of truth — it's a list of `const FIELD: usize` offsets at
the top of the file, with a comment for each field's size. The TS
decoder mirrors that list. Instruction builders are at
[clients/js/src/instructions.ts](../../../clients/js/src/instructions.ts) and
encode their data the same way the on-chain handlers decode it (e.g.
`commit_deck` packs `merkle_root[32] || proof_a[64] || proof_b[128] ||
proof_c[64]`, the handler at
[program/src/instructions/commit_deck.rs:43-46](../../../program/src/instructions/commit_deck.rs#L43-L46)
unpacks the same offsets).

What keeps this from drifting:

1. **25 client unit tests** at
   [clients/js/src/client.test.ts](../../../clients/js/src/client.test.ts) pin
   every byte offset, every PDA derivation, and every encode/decode
   round-trip.
2. **The devnet smoke test** at
   [scripts/smoke-test.ts](../../../scripts/smoke-test.ts) round-trips a
   complete game through both sides — TS encodes, the on-chain program
   decodes, the on-chain program writes account state, TS decodes the
   account state, and the test asserts the decoded card matches the
   dealer's reveal. Any layout drift surfaces immediately as either a
   runtime error or a hand-mismatch.
3. **A consciously chosen `Path B`** — see
   [docs/EXECUTION_PLAN.md](../../EXECUTION_PLAN.md) for the decision record.
   The plan was originally Shank attributes + Codama generation
   (Path A). That was deferred because the Pinocchio/Shank IDL pipeline
   wasn't stable enough at the time and the layouts are still moving.
   When the layouts freeze, the hand-written client can be replaced by a
   generated one without changing call sites — `getInitializeInstruction`
   etc. would still be the public surface.

It is more code than Codama would generate, but it is *visible* code
that exactly mirrors the program's binary contract.

### <a id="q8"></a>Q8. What does a full 4-player game cost on Solana, and where does the time go?

These are measured numbers, not estimates. They come from
[scripts/smoke-test.ts](../../../scripts/smoke-test.ts) running against the
deployed program on devnet, and they're tabulated in
[README.md](../../../README.md#performance-and-costs). Per-instruction CU
consumption:

| Instruction | Compute units |
|---|---:|
| `initialize` | ~5K |
| `join_round` | ~15K |
| `commit_deck` (Groth16) | **84,834** |
| `start_round` | ~10K |
| `hit` (Poseidon Merkle) | **7,771** |
| `stay` / `end_round` / `close_game` | ~5–15K |

A full 4-player game with ~7 turns each is ~37 signed transactions, each
charged a flat 5,000 lamports per signature. **Non-recoverable cost:
~0.000185 SOL ≈ 3.4¢** at SOL = $185. Per-game in-flight rent is
~0.018 SOL (one `GameSession`, four `PlayerState`s, one vault token
account) — all refunded on `close_game`. The 19.45 SOL devnet wallet
that ran the smoke test is good for ~100,000 full games before
exhausting transaction fees.

Latency:

| Phase | Wall clock |
|---|---|
| Network round-trip per `hit` / `stay` (`commitment=confirmed`) | ~0.6–1.0 s |
| Solana finalization (only matters if you require finality) | ~12–13 s |
| Dealer's off-chain Groth16 proof generation (snarkjs WASM, single-threaded, **once per round**) | ~18–30 s |
| On-chain Groth16 verification of that proof | ~1 s |

Wall-clock total for a 4-player game is ~50 s, dominated by the dealer's
~20 s proof generation that runs *once* at the start of the round.
Every player action after that is sub-second click-and-confirm. The
frontend will mask the proof step behind a "shuffling deck…" animation.

These numbers are the ones you cite when someone challenges whether a
ZK-verified card game is actually playable. The answer is: yes, by an
order of magnitude.

---

## Part 2 — Probing / Critical

### <a id="q9"></a>Q9. Why not Switchboard VRF? Isn't this all just a fancier oracle dance?

Yes, Switchboard VRF is the conventional answer to "I need verifiable
randomness on Solana." Pushflip deliberately doesn't use it, and the
honest reason is that **VRF and the shuffle SNARK prove different
things**, so swapping one for the other doesn't actually move the trust
needle the way it looks like it would.

A VRF gives you a verifiable random *number*. That number then has to
get *used* to derive a deck order. If the deck derivation happens
on-chain, you spend serious CU on a Fisher-Yates over a 94-card deck and
a hashing pass to commit it. If it happens off-chain, you are right back
to trusting whoever runs the derivation — i.e. the dealer service —
because the chain has no way to know they actually fed the VRF output in
honestly. The VRF would prove the *seed* was legitimately random; it
would not prove the *deck* was the result of applying that seed
correctly.

The Groth16 shuffle proof, by contrast, proves a property of the deck
itself: given a public Merkle root, the prover knew a permutation of the
canonical 94-card deck whose root matches. No duplicates. No missing
cards. No slipped-in extras. No retroactive substitution after
commitment. The trade is that it does *not* prove randomness — see
[Q10](#q10) for how the project is honest about that gap.

The comparison, because it always comes up:

| | Switchboard VRF | Pushflip (Groth16 + Poseidon) |
|---|---|---|
| Trust assumption | Oracle keypair + oracle liveness + oracle availability | Single dealer (today; see Q10 for the V2 mitigation) |
| What's proven | The output is genuinely random under the oracle's key | The committed deck is a valid 94-card permutation of the canonical deck |
| On-chain CU | Oracle callback + small verification | ~85K CU at commit, ~8K CU per `hit` |
| Ongoing cost | Per-request oracle fee | None after deploy |
| Crypto complexity | Low (oracle integration) | High (Circom circuit, trusted setup, alt_bn128 wiring) |
| Failure mode if compromised | Oracle keypair leak ⇒ predictable randomness | Dealer keypair leak ⇒ stackable deck (but never an *invalid* deck) |

The roadmap fix in [docs/EXECUTION_PLAN.md](../../EXECUTION_PLAN.md) (the
"player-contributed entropy" option) closes pushflip's randomness gap
without taking on an oracle dependency: each player commits
`hash(player_seed)` during `join_round`, the dealer's seed is mixed in,
and the circuit proves the shuffle was derived from the combined seed.
Neither side alone controls the result. The general lesson is that
"provable randomness" and "provable deck validity" are orthogonal
guarantees, and conflating them in either direction misses the point.

### <a id="q10"></a>Q10. Single trusted dealer. Call it what it is. Why isn't this just a fancier "trust me bro"?

You're right and the project documents this explicitly. The dealer
*is* a single point of trust today. The Groth16 proof is a
permutation-validity proof, not a randomness proof. The dealer knows the
entire deck order from the moment it shuffles and could, in principle,
bias the shuffle in its own favour. That's the gap.

What the gap does *not* cover, because the cryptography really does
constrain things:

- The dealer cannot deal a 95-card deck — the circuit's grand-product
  argument forces a permutation of exactly the canonical 94-card set.
- The dealer cannot deal duplicates — same reason.
- The dealer cannot reveal a card that wasn't in the committed Merkle
  tree at the position it claims — the on-chain
  [`verify_merkle_proof`](../../../program/src/zk/merkle.rs#L22) recomputes
  the root from the leaf and refuses if it doesn't match
  `game_session.merkle_root`.
- The dealer cannot retroactively change the deck after `commit_deck` —
  `deck_committed` is gated at
  [program/src/instructions/commit_deck.rs:68-70](../../../program/src/instructions/commit_deck.rs#L68-L70).
- The dealer cannot reveal cards out of order or skip ahead — the
  `leaf_index == draw_counter` check at
  [program/src/instructions/hit.rs:105-107](../../../program/src/instructions/hit.rs#L105-L107)
  forces strict sequential reveal.

That's a real envelope. It's smaller than "provably fair" sounds in
marketing copy, and the
[Fairness Model Analysis](../../EXECUTION_PLAN.md) section of the execution
plan calls it that explicitly: *"provably valid, not provably random."*

The mitigation roadmap, in order of complexity:

1. **Player-contributed entropy** — see [Q9](#q9). Post-MVP, deferred
   because it adds a commit-reveal round-trip before the round starts
   and hurts demo latency.
2. **VDF on the combined seed** — adds a time-locked computation so no
   participant can predict the final shuffle in time to manipulate
   their commitment.
3. **Threshold dealer** — multiple parties contribute shares, no single
   one knows the deck.

The project's honest position is: ship the single-dealer ZK model
first, document the trust assumption clearly in the README's "Known
Limitations" section, and treat decentralized dealing as a real V2
feature with real engineering cost. The general lesson is that being
*specific* about what your crypto buys you is more credible than
inflating it.

### <a id="q11"></a>Q11. Hand-rolled byte layouts and zero-copy without Anchor's safety nets. How do you guarantee you won't ship a misaligned read or a forgotten owner check?

You don't, statically — you guarantee it by *process*, and the process
has visible bite marks.

The first defence is that the byte offsets are centralized. Every field
of every account has exactly one source of truth: the `const X: usize`
list at the top of
[program/src/state/game_session.rs:10-33](../../../program/src/state/game_session.rs#L10-L33)
and
[program/src/state/player_state.rs:12-28](../../../program/src/state/player_state.rs#L12-L28).
Both files have a `from_bytes()` constructor that asserts
`data.len() >= MIN_DATA_LEN` (e.g.
[game_session.rs:76-84](../../../program/src/state/game_session.rs#L76-L84)),
so every accessor below that line is bounds-safe by construction. The
unit tests `test_layout_fits_in_allocation` and
`test_from_bytes_too_short` pin both invariants.

The second defence is the validation helper trio in [Q6](#q6). The
*implementation* of every owner / signer / writable check lives in one
file, so if there's a bug in the check, it's a one-line fix.

The third defence is the review process. The project has cleared at
least four `/heavy-duty-review` checkpoints, all recorded in
[docs/EXECUTION_PLAN.md](../../EXECUTION_PLAN.md):

| Date | Scope | Findings |
|---|---|---|
| 2026-04-02 | Phase 1 hardening | 9 found, all fixed |
| 2026-04-02 | Instruction handler hardening | 7 found, all fixed |
| 2026-04-03 | Early Phase 2 | 3 critical + 1 high + 3 medium, all fixed same session |
| 2026-04-09 | TS client + post-deploy Rust (the borrow-semantics one) | 24 raw → 6 confirmed (1 H, 2 M, 3 L), all fixed same session |
| 2026-04-09 | Third post-Task-2.10 review | 7 confirmed (0 C, 2 H, 5 M), all fixed same session |

The fourth heavy-duty review is the one that surfaced the bug class
this question is asking about — and the next question goes into it
specifically.

The honest residual risk is that *new* code added by future contributors
has no compile-time guarantee it'll follow the validation pattern. The
fallback there is twofold: this is a devnet deployment, not mainnet, and
a third-party audit is on the [Q17](#q17) list as a hard prerequisite
to any mainnet promotion. Reviewers + tests are not a substitute for an
audit; they are what gets you to a code state worth auditing.

### <a id="q12"></a>Q12. Pinocchio's `try_borrow_mut()` doesn't enforce `is_writable`. How many similar landmines are still in this code?

This is a real finding from the second Phase-2 heavy-duty review on
2026-04-09 (the one with 24 raw → 6 confirmed findings, 1 High / 2
Medium / 3 Low — see
[docs/EXECUTION_PLAN.md](../../EXECUTION_PLAN.md) line 1663). The empirical
discovery is in
[docs/PINOCCHIO_RESOURCE_GUIDE.md §6](pinocchio-guide.md):
calling `account.try_borrow_mut_data()` only checks Rust-side borrow
state. It does **not** check the runtime's `is_writable` flag. So if a
handler grabs a mutable borrow on an account the caller passed as
read-only and never validates it explicitly, the program *appears* to
mutate the account but the runtime silently discards the write at the
end of the instruction. The mismatch becomes a soundness gap because the
program's internal logic believes a state change happened that the chain
will not actually persist.

The remediation:

1. **Explicit `verify_writable` calls everywhere a mutable borrow is
   taken.** See e.g.
   [program/src/instructions/hit.rs:71-74](../../../program/src/instructions/hit.rs#L71-L74)
   for the post-fix pattern. The validation runs *before* any
   `try_borrow_mut` so a missing writable flag short-circuits to
   `PushFlipError::MissingWritable` instead of silently no-op-ing.
2. **`try_borrow_mut` was downgraded to `try_borrow` where the handler
   only reads.** Commit `d86eb81` and the related entry at
   [EXECUTION_PLAN.md line 1675](../../EXECUTION_PLAN.md) document the
   `burn_second_chance` and `burn_scry` cases — both only read
   `game_session`, so requesting a mutable borrow was a footgun. Both
   now use `try_borrow` and the AccountMeta in the test fixtures was
   downgraded to `new_readonly`.
3. **A dedicated guide section.** The empirical finding is recorded in
   [PINOCCHIO_RESOURCE_GUIDE.md §6](pinocchio-guide.md) with
   the rationale and the fix pattern, so the next contributor learns
   from the existing scar tissue rather than rediscovering the hole.
4. **A devnet upgrade.** The fix shipped to devnet at slot 454404501,
   upgrade tx
   `4ErSDeHoxwwQBpB1N54sWTkZJFUPTsRfzRoBsVyDCf99v4nXJv36eFbLnDjsTx5rdNxdV6T2xVSVUhWWrRRPapsQ`.
   Same data length, same rent — confirmed by the fifth heavy-duty review
   the same day.
5. **A third post-fix heavy-duty review** specifically re-checked this
   bug class after the remediation and found nothing further (7
   confirmed findings, none related to writable enforcement).

The honest residual risk is that this is still a *runtime* check that a
new contributor could forget. There is no compile-time guarantee. The
defences are: the helper exists in one file, the existing handlers are
documented examples to copy from, the guide section explicitly warns
about it, and any new instruction has to clear another heavy-duty
review before mainnet (see [Q17](#q17)). The general lesson — and the
reason this question is the most important one in the FAQ — is that
**Pinocchio gives you the bytes; it does not give you Anchor's
invariants for free**. Every invariant Anchor enforces by macro,
Pinocchio code has to enforce by hand, and the price of a missed
invariant is a class of bug that hides until it ships.

### <a id="q13"></a>Q13. Groth16 verification at ~85K CU sounds tight. What happens under congestion?

Two things to separate first: per-transaction CU is *not* the same as
per-block CU, and Solana's congestion model is priority fees, not budget
exhaustion.

The 84,834 CU figure is the *total* measured cost of a `commit_deck`
transaction including the alt_bn128 syscalls — it is not on top of an
additional ~200K CU as that question phrasing suggests. The smoke test
at
[scripts/smoke-test.ts:99](../../../scripts/smoke-test.ts#L99) sets a
`COMMIT_DECK_COMPUTE_LIMIT` of 400,000 CU, well above the measured
ceiling, and the same transaction succeeds end-to-end against devnet.
Per-transaction CU limits on Solana are 1,400,000 — `commit_deck` uses
~6%. There is plenty of headroom for both an alt_bn128 cost regression
and any protocol-card effects added later.

`hit` is the more interesting case because it runs every turn. After
the [Q4](#q4) Poseidon migration it consumes 7,771 CU. The smoke test
sets `HIT_COMPUTE_LIMIT` to 400,000 CU
([scripts/smoke-test.ts:98](../../../scripts/smoke-test.ts#L98)) so a future
regression in any single instruction won't silently cross the default
200K CU implicit limit and start failing in production. Any merge that
moves either of these numbers materially gets caught by the same smoke
test that caught the Poseidon overflow.

Block-level congestion is handled by Solana priority fees, which the
client adds independently of the program — this is *not* a program-level
concern. Pushflip does not currently set priority fees in the smoke
test, and a real frontend would set them based on observed network
load. The relevant lesson here is that the worry the question asks
about ("what if Groth16 eats your block?") is not actually how Solana
congestion works — congestion is about ordering, not capacity, and the
program's per-transaction CU usage is the measurable thing to defend.

### <a id="q14"></a>Q14. snarkjs G2 byte order vs alt_bn128 nearly shipped a broken verifier. What's stopping the next subtle crypto serialization bug?

This is a real fix and it had three layers, not one. The bug: snarkjs
serializes the BN254 G2 point with components in `[c0, c1]` order;
alt_bn128 (and the Ethereum precompile spec it mirrors) expects them in
`[c1, c0]` order. A naive port of the snarkjs proof bytes into the
on-chain verifier rejects every legitimate proof with no useful error.

The fix:

1. **Explicit byte swap in two places.** In the dealer at
   [dealer/src/prover.ts:74-90](../../../dealer/src/prover.ts#L74-L90), the
   `serializeG2()` function swaps each `(c0, c1)` pair when packing
   `proof_b` into the on-chain layout. The `serializeG2` doc comment
   spells out the convention and references snarkjs's
   `exportSolidityCallData` as the canonical example of the same swap
   in another tool. The same swap is also applied in the VK export
   script at
   [zk-circuits/scripts/export_vk_rust.mjs](../../../zk-circuits/scripts/export_vk_rust.mjs)
   so the constants baked into
   [program/src/zk/verifying_key.rs](../../../program/src/zk/verifying_key.rs)
   are pre-swapped.
2. **A VK fingerprint snapshot test.** The verifying key is hashed into
   a single 64-bit FNV-1a fingerprint by
   [program/src/zk/verifying_key.rs:140-151](../../../program/src/zk/verifying_key.rs#L140-L151).
   The expected value is pinned at
   [verifying_key.rs:120](../../../program/src/zk/verifying_key.rs#L120) as
   `0x93084a24fed22583`, and the test
   `vk_fingerprint_matches_snapshot` at
   [verifying_key.rs:168-179](../../../program/src/zk/verifying_key.rs#L168-L179)
   refuses to compile if the fingerprint changes. The test docstring
   explicitly forbids "update the constant alone" as a remediation —
   any drift requires re-running the dealer fixture, the smoke test,
   *and* a devnet redeploy.
3. **A dealer-side G2-swap fixture.** Three of the dealer's 11 tests
   are dedicated to pinning the swap convention, so a future
   "simplification" of the dealer's serialization that drops the swap
   gets caught at the dealer test layer before it ever reaches the
   on-chain verifier.

So the defence in depth is: explicit code in two coordinated places +
snapshot test + cross-validation fixture + smoke test that exercises a
real proof end-to-end. The last layer is what would catch a mismatch
that somehow slipped past the other three.

Honest acknowledgement: the *next* class of crypto serialization bug is
the one nobody has written a snapshot for yet. The general lesson is
that for any crypto-touching constant or byte layout, the right defence
is a fingerprint snapshot test with a docstring that names the failure
mode it exists to catch. That pattern is now the project's standing
template.

### <a id="q15"></a>Q15. Did you actually run a trusted setup ceremony? What ptau file are you using?

No. The trusted setup is a single-party test ceremony, and the script
that generates it says so explicitly.

[zk-circuits/scripts/setup.sh:5](../../../zk-circuits/scripts/setup.sh#L5)
opens with a comment that reads, verbatim:

> This uses a test-only ceremony. Production requires a real MPC ceremony.

The script runs `snarkjs powersoftau new bn128 19` to create a
2¹⁹-constraint Powers of Tau (the circuit at
[shuffle_verify.circom](../../../zk-circuits/circuits/shuffle_verify.circom)
sits at ~277K constraints; 2¹⁹ = 524,288 gives headroom), then a
*single* contribution with the entropy string
`"random entropy for test"`, then phase-2 setup and a single zkey
contribution with `"more random entropy"`. The resulting
`shuffle_verify_final.zkey` and `verification_key.json` are committed
to [zk-circuits/build/](../../../zk-circuits/build/), and the verifying key
constants in
[program/src/zk/verifying_key.rs](../../../program/src/zk/verifying_key.rs)
are exported from those files via
[export_vk_rust.mjs](../../../zk-circuits/scripts/export_vk_rust.mjs).

What this means in practice. Whoever holds the toxic waste from the
single contribution can — in theory — forge a proof for a deck that
isn't a valid permutation. On the current devnet deployment that
threat is the developer themselves and the impact is zero. For a
mainnet deployment with real value at stake, this would be a
disqualifying flaw. The mitigation roadmap is:

- **Use a public Powers of Tau.** Hermez / Perpetual Powers of Tau
  files exist for `bn128` and can be substituted in by replacing
  `pot19_final.ptau` with a downloaded one. The trust then collapses
  to "did at least one of the ~80 ceremony participants destroy their
  toxic waste?"
- **Run a real multi-party phase-2 ceremony.** Even after step one,
  the *circuit-specific* zkey contribution still has to be redone with
  multiple independent contributors.
- **Or migrate to a setup-free system** (Halo2, STARKs, Plonky2). This
  is a much bigger change and is not on the current roadmap.

This is one of the genuine limitations called out in the closing
section of this FAQ. The general lesson is that cryptographic *code* is
half the problem; cryptographic *operational hygiene* — keys,
ceremonies, key management — is the other half, and being honest about
which half has actually been solved is the only credible posture.

### <a id="q16"></a>Q16. Tests pass under LiteSVM but devnet revealed an 11 KB stack overflow. How is your test suite still trustworthy after that?

Alone, it isn't. That's the point of the multi-layer pyramid in
[Q5](#q5).

LiteSVM executes the program on the host architecture — x86_64 on a
developer machine, with the host's stack frame, the host's allocator,
and the host's notion of "syscall." It catches almost every logic bug,
but it cannot catch any bug that depends on the actual BPF runtime's
resource constraints. The 11 KB stack frame in
`light_poseidon::parameters::bn254_x5::get_poseidon_parameters` is
exactly that bug class: the host has megabytes of stack to spare, the
BPF runtime has 4 KB. The LiteSVM suite was green; the first devnet
call crashed at 211,142 CU.

The lesson encoded after Task 2.10 is that the devnet smoke test is
now a *required* gate, not a nice-to-have, for any change that touches
the ZK or syscall path. The smoke test at
[scripts/smoke-test.ts](../../../scripts/smoke-test.ts) is the only test
layer that:

- Runs on the real BPF runtime with the real stack frame.
- Exercises the real `sol_poseidon` syscall (not the host
  `light_poseidon` fallback).
- Exercises the real alt_bn128 syscalls for Groth16 verification.
- Charges real CU and surfaces real CU regressions.
- Pays real (devnet) lamports for transaction fees, so it also
  validates the priority-fee-free baseline.

It even has dedicated red-text error handling at
[smoke-test.ts:380-398](../../../scripts/smoke-test.ts#L380-L398) that
prints a "if this mentions stack overflow, someone re-introduced
light_poseidon" hint. That's not paranoia; that's the post-incident
process embedded directly in the only place that can catch the
recurrence.

What's still missing — and this is the open task: there is no automated
CI run of the smoke test against a disposable devnet keypair. It's a
manual `pnpm --filter @pushflip/scripts smoke-test` invocation that the
developer has to remember to run. Adding it to CI is on the [Q17](#q17)
mainnet-readiness list. The general lesson is that *test
representativity* matters more than *test count*, and a 98-test green
suite that doesn't include a representative test for a class of bug is
not green for that class of bug.

### <a id="q17"></a>Q17. What would actually need to happen for this to ship to mainnet?

A real list, in roughly the order it should be tackled.

1. **Third-party audit.** Internal reviews, no matter how diligent,
   are not an audit. Five+ heavy-duty reviews caught five+ batches of
   real bugs. The sixth review needs to be an outside firm with no
   prior context, ideally one with Pinocchio + alt_bn128 experience.
   This is the gating item.
2. **Real trusted-setup ceremony.** As discussed in [Q15](#q15), the
   current zkey is a single-party test ceremony with the entropy
   string `"random entropy for test"`. Either swap in a public Powers
   of Tau and run a real multi-party phase-2 ceremony, or migrate the
   proof system. No mainnet without one.
3. **Player-entropy mitigation for dealer trust.** Discussed in
   [Q9](#q9) and [Q10](#q10). The current single-dealer model is
   acceptable on devnet; it's not acceptable for real value at stake.
4. **Smoke test in CI.** The smoke test
   ([Q16](#q16)) is currently a manual run. It needs to be a GitHub
   Actions job against a disposable devnet keypair, gated on every PR
   that touches `program/src/zk/`, `program/src/instructions/`,
   `dealer/src/`, or `clients/js/src/`.
5. **SPL Token mint deployment + tokenomics finalisation.** The
   integration tests currently create a per-test mint via a helper.
   Mainnet deployment needs a single canonical $FLIP mint, an
   authority key management plan, and a documented supply schedule.
6. **Frontend (Phase 3).** The [app/](../../../app/) directory is currently
   a `package.json` stub. Phase 3 in
   [docs/EXECUTION_PLAN.md](../../EXECUTION_PLAN.md) details the Vite + React
   scaffold that needs to be built on top of the now-stable client.
7. **House AI agent (Phase 4).** The
   [house-ai/](../../../house-ai/) package is also a stub. The single-player
   experience needs an opponent.
8. **Operational runbook.** Devnet deploy is documented in the README;
   mainnet upgrade authority management, key rotation, incident
   response, and proof-key rotation are not.

That list reframes the question from "is it production-ready?" (no) to
"what specifically does production-readiness mean for this codebase?"
(eight specific items, in order). The general lesson is that being able
to *enumerate* the gap is more credible than claiming there isn't one.

---

## Honest Limitations

Reading this whole document straight through, here are the genuine
caveats it acknowledges, in one place so they're impossible to miss:

- **Single trusted dealer.** Cryptography proves the deck is a valid
  permutation, not that the shuffle was random. ([Q10](#q10))
- **Test-only trusted setup ceremony.** Not safe for real-money
  deployment without a real MPC ceremony. ([Q15](#q15))
- **Devnet only.** Not audited. Not on mainnet. The path there is
  enumerated in [Q17](#q17).
- **Hand-rolled validation.** Pinocchio has no `#[derive(Accounts)]`,
  so account-validation correctness is enforced by review, tests, and
  documented patterns — not by the type system. ([Q11](#q11),
  [Q12](#q12))
- **Frontend and House AI not yet built.** Phase 3 and 4 of the
  execution plan are scaffolded but not implemented.
