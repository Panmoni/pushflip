# PushFlip

A crypto-native push-your-luck card game on Solana. Stake tokens, burn for power, and play against an AI-driven House -- all with provably fair shuffling via ZK proofs.

**[pushflip.xyz](https://pushflip.xyz)**

## What It Is

PushFlip is an on-chain card game with hit/stay mechanics, a $FLIP token economy, and zero-knowledge proof deck verification. Every shuffle is provably fair using Groth16 + Poseidon Merkle trees -- no trust required.

## Built With

- **Pinocchio** -- zero-dependency native Rust on Solana (no Anchor)
- **ZK-SNARKs** -- Groth16 proofs for provably fair deck shuffling
- **$FLIP Token** -- SPL token with stake-to-play and burn-for-power mechanics
- **@solana/kit** -- modern Solana TypeScript SDK
- **React + Vite** -- frontend
- **Hand-written TypeScript client** -- direct mirror of Pinocchio's manual byte layouts (no Shank / Codama indirection)

## Features

- On-chain game sessions with PDA-managed state
- AI opponent ("The House") that plays autonomously
- ZK-verified deck commitment -- cards are revealed progressively with proof
- Token staking and burning integrated into gameplay
- Flip Advisor -- real-time probability assistant

## Performance and Costs

All numbers below are measured empirically against the live devnet program (`HQLeAQc84WLz8buHM5JAJGBjNJjwc6Fpxts8jSMaW3px`) via [`scripts/smoke-test.ts`](scripts/smoke-test.ts), not estimates.

### Per-transaction fees

Solana charges a flat **5,000 lamports per signature** (≈ 0.000005 SOL ≈ $0.001 at SOL = $185), independent of how many compute units the transaction uses. Compute consumption per instruction:

| Instruction | Compute units | Tx fee |
|---|---:|---:|
| `initialize` | ~5 K | 0.000005 SOL |
| `join_round` | ~15 K | 0.000005 SOL |
| `commit_deck` (Groth16 verification) | **84,834** | 0.000005 SOL |
| `start_round` | ~10 K | 0.000005 SOL |
| **`hit` (Poseidon Merkle verification)** | **7,771** | 0.000005 SOL |
| `stay` / `end_round` / `close_game` | ~5–15 K | 0.000005 SOL |

`hit` and `commit_deck` are the two heavy ones. Both currently fit comfortably under their compute-unit budgets and were validated end-to-end on devnet.

### Per-account rent

Account rent on Solana is a refundable deposit, not a recurring cost. Closing the account returns the rent to the original payer.

| Account | Size | Rent | Paid by |
|---|---:|---:|---|
| `GameSession` PDA | 512 B | 0.00445 SOL | authority, once per game |
| `PlayerState` PDA | 256 B | 0.00267 SOL | each player, once per game |
| Vault SPL token account | 165 B | 0.00204 SOL | authority, once per game |

### What a full game actually costs

A 4-player game with ~7 turns each:

| | SOL | At $185 / SOL |
|---|---:|---:|
| Non-recoverable tx fees (~37 signatures across the round) | ~0.000185 | **~3.4 ¢** |
| In-flight rent (refunded on `close_game` / `leave_game`) | ~0.018 | $0 net |

**A single turn costs you one tenth of one cent.** The 19.45 SOL devnet wallet that ran the smoke tests is good for ~100,000 full games before exhausting tx fees.

### Latency: how long does a turn take?

| Phase | Wall clock |
|---|---|
| Network round-trip per `hit` / `stay` (commitment = `confirmed`) | **~0.6–1.0 s** |
| Solana finalization (only relevant if you require finality) | ~12–13 s |
| Dealer's off-chain Groth16 proof generation (snarkjs WASM, single-threaded, **once per round**) | ~18–30 s |
| On-chain Groth16 verification of that proof | ~1 s |

A turn feels instant. The only noticeable wait is the proof generation that runs *once* at the start of each round — the frontend can mask it behind a "shuffling deck…" animation. After that, every player action is a sub-second click-and-confirm.

A full game's wall clock works out to roughly:

```
20 s  (dealer generates Groth16 proof)
 1 s  (commit_deck verifies on chain)
 1 s  (start_round)
~30 s  (4 players × ~7 turns × ~1 s each, plus think time)
 1 s  (end_round + close_game)
─────
~50 s end-to-end, completely independent of player count after the proof step
```

### Why these numbers are this good

The on-chain hot path uses Solana's native `sol_poseidon` syscall (~7 K CU per `hit`) instead of an in-program `light_poseidon` implementation (~211 K CU and a stack overflow). See [docs/PINOCCHIO_RESOURCE_GUIDE.md §11](docs/PINOCCHIO_RESOURCE_GUIDE.md#11-poseidon-hashing-via-sol_poseidon-syscall) for the wrapper that made this possible — it's the closest thing this repo has to a portfolio-positive open-source contribution.

## How the ZK System Works

Every deck shuffle in PushFlip is provably fair using zero-knowledge cryptography. Here's the pipeline:

### The Big Picture

We want to prove "the deck was shuffled fairly" without revealing the shuffle order until cards are drawn. That's what ZK-SNARKs do -- prove a computation was done correctly without revealing the private inputs.

### The Pipeline

```
Circom Circuit ──compile──> R1CS (constraints)
                                │
Powers of Tau (.ptau) ──────────┤
                                ▼
                        Groth16 Setup
                          │        │
                   Proving Key    Verification Key
                    (127 MB)      (few hundred bytes)
                      │                  │
                      ▼                  ▼
    Dealer: shuffle + proof gen    On-chain: verify proof
              (off-chain)            (~200K compute units)
```

**Circom circuit** (`zk-circuits/circuits/shuffle_verify.circom`) -- Defines the math that must be satisfied: "given this Merkle root (public), I know a permutation (private) that produces a valid 94-card deck." Compiles to ~362K constraints. The circuit enforces three properties:

1. **Valid bijection** -- Grand product argument proves every card index appears exactly once
2. **Correct mapping** -- Constrained multiplexer proves shuffled cards match the canonical deck at permuted positions
3. **Merkle commitment** -- Poseidon Merkle tree binds the shuffled order to a single root hash

**Powers of Tau (.ptau)** -- A one-time ceremony that generates shared cryptographic randomness. Think of it as "trusted cosmic noise" that makes the proof system work. The ceremony has multiple contributors -- as long as *one* was honest, the whole thing is secure. Reusable across any circuit of that size or smaller.

**Proving key (.zkey)** -- Circuit-specific key generated by combining the ptau with the circuit's constraint system. This is what the dealer needs to create proofs. ~127MB because the circuit is large.

**Verification key** -- The small counterpart extracted from the zkey. This goes on-chain as Rust byte arrays in the Solana program. A few hundred bytes vs the 127MB proving key.

**Proof generation** -- The dealer feeds private inputs (the shuffle permutation) + public inputs (Merkle root, canonical deck hash) into the WASM witness generator + zkey. Out comes a ~256-byte proof that can convince anyone the computation was valid.

**On-chain verification** -- The Solana program takes the proof + public inputs + verification key and runs a pairing check via alt_bn128 syscalls. ~200K compute units. Returns pass/fail.

### Card Reveal Flow

After the deck is committed, cards are revealed one at a time:

1. Player calls `hit` -- requests the next card
2. Dealer provides the card data + a Merkle proof for that leaf position
3. On-chain program verifies the Merkle proof against the stored root
4. If valid, the card is added to the player's hand

The Merkle proof guarantees: this card was part of the originally committed deck at that exact position. The dealer cannot swap cards mid-game.

### Mental Model

Think of it like a notarized document:
- **ptau** = the notary's credentials (shared, reusable)
- **zkey** = a stamp specific to this type of document
- **proof** = the stamped document itself
- **verification key** = what the court needs to verify the stamp is legit

The magic: the court (on-chain verifier) can confirm the document is valid without ever seeing the original content (the shuffle order).

### Known Limitations

The current system uses a **single trusted dealer** that chooses the shuffle. The ZK proof proves the deck is a *valid* permutation but does NOT prove it was shuffled *randomly*. Players must trust the dealer shuffled honestly. See the [execution plan](docs/EXECUTION_PLAN.md) for the roadmap to player-contributed entropy and decentralized dealing.

A related limitation: Groth16 proofs are **not bound to a specific game session.** A valid proof for game #1 is mathematically valid for game #2 with the same canonical deck, because the public inputs are only `(merkle_root, canonical_hash)` — no game_id. In practice this is only exploitable by the dealer themselves (who already knows the deck preimage), so it reduces to "the dealer must not reuse shuffles across games" — which is the same trust assumption as the single-dealer model. The proper fix is to add `game_id` as a third public input to the circuit, which is part of the same threshold-randomness rework planned for post-MVP. Tracked in [docs/EXECUTION_PLAN.md](docs/EXECUTION_PLAN.md) Pre-Mainnet Checklist 5.0.2.

## Deployment

### Live Devnet Deployment

| Field | Value |
|-------|-------|
| **Program ID** | `HQLeAQc84WLz8buHM5JAJGBjNJjwc6Fpxts8jSMaW3px` |
| **Cluster** | Devnet |
| **Loader** | BPF Loader Upgradeable |
| **First deployed** | 2026-04-09 (slot 454396197) |
| **Binary size** | ~364 KB |
| **Rent** | ~2.6 SOL |

Inspect on-chain with:

```bash
solana program show HQLeAQc84WLz8buHM5JAJGBjNJjwc6Fpxts8jSMaW3px --url devnet
```

### Deploying from Source

These steps deploy a fresh build to devnet from a clean checkout. Run from the repo root.

#### Prerequisites

1. **Solana CLI** installed and configured for devnet:
   ```bash
   solana config set --url https://api.devnet.solana.com
   solana config get
   ```
2. **A funded devnet wallet** at `~/.config/solana/id.json` with at least **3 SOL** (deployment costs ~2.6 SOL in rent plus tx fees). Top up with `solana airdrop 2` if needed.
3. **The program keypair** at `target/deploy/pushflip-keypair.json`. This file is generated automatically by `cargo build-sbf` on first build. Its public key **must match** the address in `program/src/lib.rs` (`declare_id!(...)`). Verify with:
   ```bash
   solana-keygen pubkey target/deploy/pushflip-keypair.json
   ```

#### Build the BPF binary

The deploy binary must be built **without** the `skip-zk-verify` feature flag, so that on-chain Groth16 verification is enabled:

```bash
rm -f target/sbpf-solana-solana/release/deps/pushflip.so target/deploy/pushflip.so
cargo build-sbf --manifest-path program/Cargo.toml --sbf-out-dir target/deploy
```

> The `--manifest-path` flag is required because the workspace `tests/` crate pulls in dependencies that conflict with the BPF toolchain's older Cargo. Building only the `program/` crate avoids the conflict.
>
> The historical `Stack offset of 10960` linker warning from `light_poseidon` is gone as of Task 2.10 — the on-chain code now calls Solana's native `sol_poseidon` syscall and `light_poseidon` is a host-only test dependency. See [docs/POSEIDON_STACK_WARNING.md](docs/POSEIDON_STACK_WARNING.md) for the full migration story.
>
> Integration tests (`cargo test`) build their own copy of the program with `--features skip-zk-verify` into `target/deploy-test/pushflip.so` via [`tests/build.rs`](tests/build.rs), so they never clobber the deploy artifact at `target/deploy/pushflip.so`.

Verify the binary was produced:

```bash
ls -lh target/deploy/pushflip.so
```

#### Deploy

```bash
solana program deploy target/deploy/pushflip.so
```

This uploads the program in chunks (30 seconds to a few minutes depending on network). Successful output looks like:

```
Program Id: HQLeAQc84WLz8buHM5JAJGBjNJjwc6Fpxts8jSMaW3px
Signature: <base58 transaction signature>
```

If the deploy fails partway through (network hiccup, RPC timeout), the CLI prints a recovery command of the form `solana program deploy --buffer <BUFFER_ADDRESS>`. **Save it** — re-running it resumes the deploy without losing the SOL already spent on the buffer account.

#### Verify

```bash
solana program show HQLeAQc84WLz8buHM5JAJGBjNJjwc6Fpxts8jSMaW3px
```

Expect:
- `Owner: BPFLoaderUpgradeab1e11111111111111111111111` (upgradeable, not the read-only loader)
- `Authority: <your wallet pubkey>` (the deployer can ship upgrades)
- `Data Length: ~372640` bytes
- `Balance: ~2.6 SOL` (rent)

#### Upgrading

To deploy a new version of the program (same ID, new bytecode):

```bash
# Rebuild
cargo build-sbf --manifest-path program/Cargo.toml --sbf-out-dir target/deploy

# Upgrade — same command, Solana detects an existing program and upgrades it
solana program deploy target/deploy/pushflip.so
```

The deploy authority (your wallet) is required to sign the upgrade. Upgrades cost a small tx fee but no additional rent.

#### Reclaiming rent (closing the program)

To recover the ~2.6 SOL rent from a deployed program:

```bash
solana program close HQLeAQc84WLz8buHM5JAJGBjNJjwc6Fpxts8jSMaW3px --bypass-warning
```

⚠️ This is **irreversible** — the program ID becomes permanently unusable. Only do this if you're abandoning the deployment.

## Documentation

- [docs/FAQ.md](docs/FAQ.md) — technical Q&A covering architecture, ZK design, trade-offs, and known limitations. Start here if you want depth without reading code.
- [docs/EXECUTION_PLAN.md](docs/EXECUTION_PLAN.md) — phase-by-phase task breakdown, decisions log, and lessons learned across the build.
- [docs/ZK_RESEARCH.md](docs/ZK_RESEARCH.md) — survey of Solana ZK primitives and the rationale for choosing Groth16 + Poseidon over the alternatives.
- [docs/PINOCCHIO_RESOURCE_GUIDE.md](docs/PINOCCHIO_RESOURCE_GUIDE.md) — Pinocchio internals, gotchas (including the borrow-semantics footgun), and the `sol_poseidon` syscall wrapper write-up.
- [docs/POSEIDON_STACK_WARNING.md](docs/POSEIDON_STACK_WARNING.md) — retrospective on the `light_poseidon` BPF stack overflow and the syscall migration that resolved it.
- [docs/SOLANA_KIT_GUIDE.md](docs/SOLANA_KIT_GUIDE.md) — `@solana/kit` v2 usage notes for the TypeScript client.
- [docs/HOSTING_AND_RPC.md](docs/HOSTING_AND_RPC.md) — RPC provider and hosting decisions.
- [docs/CLAUDE_HOOKS.md](docs/CLAUDE_HOOKS.md) — Claude Code hook safety net configuration.

## Contributing

Outside contributors are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for project status, build/test commands, code conventions, and three well-scoped open work tracks (native Rust dealer with arkworks, threshold randomness protocol, House AI agent in Rust). Each track is self-contained and can be owned end-to-end.

## Development

This repo is AI-assisted via Claude Code and ships a set of [Claude Code hooks](docs/CLAUDE_HOOKS.md) as a safety net: protected-file guards for program keypairs / ZK artifacts / [notes.md](notes.md), blocked-command patterns for irreversible Solana and git operations, auto-format (`rustfmt` / `prettier`), `cargo check` feedback after edits, and a pre-PR test gate. See [docs/CLAUDE_HOOKS.md](docs/CLAUDE_HOOKS.md) for the full list.

## License

Copyright 2026 George Donnelly and Alex Ramirez, the PushFlip developers

Licensed under the [Apache License, Version 2.0](LICENSE) (the "License"). You may not use this project except in compliance with the License. Unless required by applicable law or agreed to in writing, the software is distributed on an "AS IS" basis, without warranties or conditions of any kind, either express or implied. See the [LICENSE](LICENSE) file for the specific language governing permissions and limitations under the License.

Contributions submitted to this project are licensed under the same Apache License 2.0 by virtue of Section 5 of the License ("inbound = outbound"). No separate Contributor License Agreement is required.

"PushFlip" and "$FLIP" are not registered trademarks. Per Section 6 of the License, the Apache License does not grant permission to use the project name or token symbol for purposes other than reasonable and customary use in describing the origin of the work.
