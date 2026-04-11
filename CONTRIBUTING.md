# Contributing to PushFlip

This document is for outside contributors who want to build a substantial,
self-contained piece of the project. For project goals and the full task
plan, see [docs/EXECUTION_PLAN.md](docs/EXECUTION_PLAN.md). For the
user-facing pitch and known limitations, see [README.md](README.md).

Maintainer contact: [@georgedonnelly on Telegram](https://t.me/georgedonnelly).

## Project status

- **On-chain program** ([program/](program/)) — stable. 16 instructions
  deployed to devnet at `HQLeAQc84WLz8buHM5JAJGBjNJjwc6Fpxts8jSMaW3px`,
  every instruction has at least one passing devnet smoke-test signature.
  See the on-chain green-light report in
  [docs/EXECUTION_PLAN.md](docs/EXECUTION_PLAN.md) (Task 3.A.6).
- **ZK pipeline** ([zk-circuits/](zk-circuits/), [dealer/](dealer/)) — stable.
  Groth16 proofs verify on-chain in ~85K compute units. The verifying key
  is pinned by a snapshot fingerprint test in
  [program/src/zk/verifying_key.rs](program/src/zk/verifying_key.rs).
- **TypeScript client** ([clients/js/](clients/js/)) — stable. Hand-written on
  `@solana/kit` v6. 26 unit tests passing (includes a Kit transaction-builder
  integration test).
- **Frontend** ([app/](app/)) — Phase 3B, in progress. Vite 8 + React 19 +
  Tailwind v4 + Biome/Ultracite + `@solana/kit` v6 + shadcn (radix base, nova
  preset; button/card/dialog/sonner installed). State via React Query 5.x +
  Zustand 5.x. Wallet adapter ↔ Kit bridge uses `@solana/web3.js` 1.x +
  `@solana/compat`. Phase 3.1 (scaffold + providers + RPC clients) and
  Phase 3.2 (program integration hooks: `useGameSession`, `usePlayerState`,
  `useGameActions`) are complete. Read hooks verified end-to-end against
  devnet. Task 3.3 (game board components) is next.
- **House AI** (`house-ai/`) — Phase 4, not started. Currently scoped as
  Node + TypeScript in the plan.
- **Threshold randomness** — post-MVP. Documented as Task 5.0.2. The current
  dealer is single-trusted.

## Toolchain

| Tool | Version |
|---|---|
| Rust | 1.84+ (matches the BPF toolchain) |
| Solana CLI | 2.x |
| Node.js | 20+ |
| pnpm | 9+ |
| circom | 2.x (for circuit work only) |

## Building and testing

```bash
# Build the on-chain program (production binary, real Groth16 verify)
cargo build-sbf --manifest-path program/Cargo.toml --sbf-out-dir target/deploy

# Run all Rust tests (auto-builds a separate test binary into
# target/deploy-test/pushflip.so via tests/build.rs)
cargo test

# Lint
cargo fmt --all
cargo clippy --all-targets --all-features -- -D warnings

# TypeScript client tests
cd clients/js && pnpm test

# Devnet smoke tests (require a funded devnet keypair)
cd scripts && pnpm tsx smoke-test.ts
```

The deploy binary lives at `target/deploy/pushflip.so` and the test binary at
`target/deploy-test/pushflip.so`. They cannot collide. Never build the deploy
binary with `--features skip-zk-verify` — the build script will print a
loud `cargo:warning=` block if you do.

## Code conventions

- **Pinocchio, not Anchor.** All on-chain account validation is manual. See
  [.claude/rules/blockchain-patterns.md](.claude/rules/blockchain-patterns.md)
  and the [Pinocchio Guide](docs/wiki/reference/pinocchio-guide.md) in the wiki.
- **`@solana/kit`, not `web3.js` v1 or `gill`.** All client code uses the
  current Anza-maintained SDK.
- **Hand-written TS client, not Codama.** Pinocchio's manual byte layouts
  make a parallel Shank/Codama representation more cost than benefit.
- **No `#[allow(dead_code)]`.** The cleanup-pass rule is delete-or-use. See
  Task 3.B.End in the execution plan.
- **Conventional commit format.** `<type>(<scope>): <description>` with
  imperative-mood subjects. No co-author trailers.
- **Run `cargo fmt` and `cargo clippy -- -D warnings` before opening a PR.**
- **Never silence pre-commit hooks** (`--no-verify`, `--no-gpg-sign`).

## Wiki contributions

Project documentation lives in an MkDocs Material wiki at [`docs/wiki/`](docs/wiki/index.md). When editing or adding wiki pages:

- **Every page declares frontmatter** with at minimum `title`, `diataxis_type`, and `last_compiled` (YYYY-MM-DD). See [`docs/wiki/meta/frontmatter-template.md`](docs/wiki/meta/frontmatter-template.md) for the full schema. The health check script will fail your PR if any required field is missing.
- **`diataxis_type` follows the [Diátaxis framework](https://diataxis.fr/)** — exactly one of `how-to`, `reference`, `explanation`, or `tutorial`. If you're unsure, default to `explanation` for prose docs and `reference` for tables/specifications.
- **Update `last_compiled` to today's date** every time you edit a page. The weekly CI sweep flags pages older than 60 days.
- **Cross-reference between wiki pages** with relative paths inside `docs/wiki/`. Cross-reference into the rest of the repo with paths relative to `docs/wiki/<section>/` — three levels up to reach the repo root.

### Local preview

```bash
# One-time setup (Python 3.12+ required)
python3 -m venv wiki/.venv
wiki/.venv/bin/pip install -r wiki/requirements.txt

# Health check + strict build (CI runs the same)
bash scripts/wiki-health-check.sh --strict
wiki/.venv/bin/mkdocs build -f wiki/mkdocs.yml --strict

# Live preview
wiki/.venv/bin/mkdocs serve -f wiki/mkdocs.yml
# → http://127.0.0.1:8000
```

The wiki is validated on every PR via `.github/workflows/wiki-build.yml`, plus a weekly Monday cron job that runs the staleness sweep against `main`.

## Open work for outside contributors

The following three pieces are well-scoped, can be owned end-to-end by a
single contributor, and do not collide with anything currently in flight on
`main`. Pick one, open an issue or DM the maintainer to claim it before
starting, and explain your rough approach.

---

### Option 1: Native Rust dealer using arkworks

Replace the Node.js + snarkjs implementation in [dealer/](dealer/) with a
native Rust binary that uses [`ark-bn254`](https://github.com/arkworks-rs/curves),
[`ark-groth16`](https://github.com/arkworks-rs/groth16), and
[`ark-circom`](https://github.com/arkworks-rs/circom-compat) to generate
proofs against the existing circom circuit.

**Scope:**
- New `dealer-rs/` crate (or replace `dealer/` entirely once parity is
  proven). HTTP service compatible with the existing dealer's request/response
  shape so the frontend and house-ai can swap implementations transparently.
- Witness generation from the existing
  [zk-circuits/circuits/shuffle.circom](zk-circuits/circuits/shuffle.circom)
  artifact (either via `ark-circom`'s wasm witness reader or a native
  rewrite).
- Byte-identical proof output: every proof generated by the Rust dealer must
  pass `verify_shuffle_proof` in [program/src/zk/groth16.rs](program/src/zk/groth16.rs).
- Cross-validation test suite that runs both dealers against the same seed
  and asserts the proofs verify against the same on-chain VK.

**Pros:**
- Directly attacks the documented performance bottleneck. The current dealer
  is ~18-30s per proof, single-threaded WASM, ~1.5 GB RAM. See
  [docs/HOSTING_AND_RPC.md](docs/HOSTING_AND_RPC.md) for the full sizing
  analysis. A multi-threaded Rust implementation should significantly
  reduce both wall-clock time and memory footprint, which is what would
  let the project scale beyond 2 concurrent games on a small VPS.
- Strong arkworks experience for the contributor — `ark-bn254`,
  `ark-groth16`, R1CS witness generation, and Solana alt_bn128 byte-order
  conventions are all genuinely useful Rust ZK skills.
- Self-contained. Does not touch on-chain code, the TS client, the circuit,
  or the verifying key. The interface is frozen.
- Test oracle is unambiguous: proofs either verify against the existing
  on-chain VK or they do not.

**Cons / risks:**
- The bn254 G2 byte order is `[c1, c0]`, not `[c0, c1]` (per EIP-197 and the
  Solana `alt_bn128_pairing` syscall). Both the proof and the verifying key
  must use this order. The existing TS dealer documents this in
  `dealer/src/prover.ts::serializeG2`. Getting it wrong fails silently — the
  prover will accept the proof, the verifier will reject it, and there is
  no useful error message. See lessons #4 and #6 in
  [docs/EXECUTION_PLAN.md](docs/EXECUTION_PLAN.md).
- `ark-circom` is less mature than snarkjs. Witness generation from the
  circom `.wasm` artifact is the most fragile interop point.
- The performance win is hypothetical until measured. arkworks `ark-groth16`
  is not automatically faster than snarkjs — gains come from parallel
  witness generation and avoiding the WASM boundary.

**Coordination cost:** Low. One directory, frozen interface, regression
suite already exists (the on-chain verifier and the TS dealer's test
fixtures).

---

### Option 2: Threshold randomness protocol (Task 5.0.2)

Implement a multi-party commit-reveal protocol so the shuffle seed is not
chosen by a single trusted dealer. The current dealer can pick a shuffle
that favors a specific player; the Groth16 proof guarantees only that the
shuffle is a valid permutation, not that it is unbiased. This is documented
as the largest cryptographic limitation in [README.md](README.md).

**Scope:**
- Two new on-chain Pinocchio instructions: `commit_nonce` (each player
  submits `H(nonce_i)` before `start_round`) and `reveal_nonce` (each player
  reveals `nonce_i` after `commit_deck`).
- New fields in `GameSession` (`program/src/state/game_session.rs`) to track
  per-player nonce commitments and reveals. The byte layout will need to
  grow; account for the rent delta in `initialize`.
- A new derived shuffle seed: `XOR(nonce_1 .. nonce_N)`, computed on-chain
  in `start_round` (or `commit_deck`, depending on the design).
- Dealer changes to consume the derived seed instead of choosing its own.
- Tests for the case where N-1 players collude — the protocol should be
  secure as long as one player contributed honestly.
- Update `README.md` "Known Limitations" to remove the single-trusted-dealer
  caveat once the protocol ships.

**Pros:**
- The most cryptographically novel piece of work available in the project.
- Removes the largest documented integrity weakness. Tangible product impact.
- End-to-end ownership across the stack: on-chain Rust, state layout,
  dealer changes.

**Cons / risks:**
- Highest coordination cost of the three options. Touches `GameSession`
  state layout (which the TS client decodes), the dispatcher in
  `program/src/lib.rs`, the smoke tests, and the dealer. Every PR collides
  with concurrent work in those files.
- New admin/state-mutation instructions are exactly the surface area where
  heavy-duty review #5 found the C1 + H1 exploits. The contributor must
  read lessons #26-29 in [docs/EXECUTION_PLAN.md](docs/EXECUTION_PLAN.md)
  before designing the new instructions, and the work will need its own
  heavy-duty review pass before merging.
- The plan estimates 3-5 days of work, but in practice this is likely
  1-2 weeks for a contributor who is new to Pinocchio's manual byte layouts
  and dispatcher conventions.
- Requires a re-deploy of the on-chain program after merging, plus updated
  smoke tests for every existing instruction (because `GameSession`'s byte
  layout changes).

**Coordination cost:** High. Plan a kickoff call to align on the byte
layout changes, the new error variants, and which existing tests will need
to be updated.

---

### Option 3: House AI agent in Rust

Replace the planned Node + TypeScript Phase 4 House AI with a native Rust
binary using [`solana-client`](https://docs.rs/solana-client) (or a Rust
RPC crate like [`helius-rs`](https://github.com/helius-labs/helius-rust-sdk))
plus the existing on-chain instruction definitions.

**Scope:**
- New `house-ai/` crate. Subscribes to `GameSession` account changes,
  detects when it is the House's turn, runs a strategy engine, builds and
  signs `hit`/`stay`/`burn_*` transactions, and submits them.
- Strategy engine: hand evaluation, bust probability, hit/stay decision
  logic. Free to be as fancy as the contributor wants — Monte Carlo
  rollouts of the remaining deck, expectimax search, etc.
- WebSocket subscription with polling fallback (the existing smoke tests
  exercise both paths via `@solana/kit`; the Rust equivalent is
  `solana-client::pubsub_client`).
- Graceful shutdown, balance monitoring, structured logging.
- End-to-end test against devnet: the House should be able to play a full
  round autonomously against a scripted human opponent.

**Pros:**
- Pure product work. The result is visible and demonstrable — anyone can
  play against the bot on devnet, which is more concrete than a dealer
  rewrite or a protocol change.
- Zero coordination cost. The House AI is a separate process talking to
  the same RPC as the frontend. It does not touch any existing Rust or
  TypeScript code.
- Single binary, easy to deploy. Fits the existing OVH VPS hosting plan
  in [docs/HOSTING_AND_RPC.md](docs/HOSTING_AND_RPC.md).
- Strategy engine has open design space — opportunity for genuine
  algorithmic work.

**Cons / risks:**
- Least cryptographically interesting of the three. It is "another Solana
  client, in Rust." The contributor will not learn anything new about ZK
  or Pinocchio.
- Overlaps with the existing Phase 4 plan
  ([docs/EXECUTION_PLAN.md](docs/EXECUTION_PLAN.md) Tasks 4.1 → 4.5),
  which is currently scoped as Node + TypeScript. The maintainer needs to
  decide upfront whether to delete the existing Phase 4 plan or treat the
  Rust version as a parallel implementation.
- `solana-client` is heavier than `@solana/kit`. The Rust dependency tree
  for a basic Solana client is significantly larger than the TS equivalent;
  build times will be noticeably longer.

**Coordination cost:** Low, contingent on the maintainer agreeing to
replace the Node Phase 4 plan with the Rust implementation. Otherwise:
medium, because the two implementations would coexist.

---

## Claiming a piece of work

Before starting, open an issue (or DM the maintainer at
[@georgedonnelly on Telegram](https://t.me/georgedonnelly)) with:

1. Which option you are picking.
2. Your rough approach and any open design questions.
3. An estimate of how much time you can commit, and on what cadence.

Once a piece is claimed, ownership is yours until you ship or step away.
If you step away, please say so explicitly so the slot can re-open.

## PR process

1. Branch from `main`. Keep PRs focused — one logical change per PR.
2. Run `cargo fmt --all`, `cargo clippy --all-targets --all-features -- -D warnings`,
   and `cargo test` before opening the PR. All three must be clean.
3. For on-chain changes, also re-run the relevant smoke test against devnet
   and include the transaction signature in the PR description.
4. Use conventional commit format. No co-author trailers.
5. Expect a review pass focused on Pinocchio account validation correctness,
   borrow safety, and (for ZK changes) cross-implementation byte
   compatibility. Heavy-duty reviews are scheduled for any non-trivial
   on-chain or cryptographic change.
