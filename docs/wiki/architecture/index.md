---
title: System Design
diataxis_type: explanation
last_compiled: 2026-04-11
sources:
  - program/src/lib.rs
  - dealer/src/index.ts
  - clients/js/src/instructions.ts
  - app/src/lib/wallet-bridge.ts
related_wiki:
  - architecture/glossary.md
  - architecture/game-session-byte-layout.md
  - reference/zk-research.md
  - history/poseidon-stack-warning.md
---

# System Design

PushFlip is a crypto-native push-your-luck card game on Solana. Players join a [GameSession](glossary.md#gamesession), stake [`$FLIP`](glossary.md#flip-token) tokens, and decide whether to **hit** (draw another card) or **stay** (lock in their score) against an AI [House](glossary.md#house) opponent. Every shuffle is provably fair via Groth16 zero-knowledge proofs over a Poseidon Merkle tree — players never have to trust the dealer about deck order, only about not reusing shuffles.

This page is the high-level overview. For terminology, see the [Glossary](glossary.md). For the on-chain account byte layout, see [GameSession Byte Layout](game-session-byte-layout.md). For the security assumptions and known limitations, see the [Threat Model](threat-model.md).

## Components

PushFlip is four moving parts that talk to each other:

```
┌──────────────────┐         ┌────────────────────┐
│  Frontend (React)│ ◄─────► │  Solana Program    │
│  Vite + Kit + WC │  RPC    │  (Pinocchio, ~80KB)│
└──────────────────┘         └────────────────────┘
        ▲                             ▲
        │ wallet                      │ commit_deck
        │ adapter                     │ + hit (with Merkle proof)
        ▼                             │
┌──────────────────┐         ┌────────┴───────────┐
│  Wallet Adapter  │         │  Dealer Service    │
│  (Phantom etc.)  │         │  (Node, snarkjs)   │
└──────────────────┘         └────────────────────┘
```

| Component | Stack | Lives in | Job |
|---|---|---|---|
| **On-chain program** | Pinocchio (native Rust, no Anchor), zero deps | [`program/`](https://github.com/Panmoni/pushflip/blob/main/program) | State machine for the game. 16 instructions covering initialize/join/commit/start/hit/stay/end/close + token economics + bounty system. Runs on Solana devnet at `HQLeAQc84WLz8buHM5JAJGBjNJjwc6Fpxts8jSMaW3px`. |
| **Dealer service** | TypeScript + snarkjs (Node) | [`dealer/`](https://github.com/Panmoni/pushflip/blob/main/dealer) | Off-chain. Generates the shuffle, builds the Groth16 proof against the Circom circuit, hands the deck commitment + proof to the program via `commit_deck`, then serves Merkle proofs for each card on `hit`. |
| **Frontend** | Vite + React 19 + Tailwind v4 + `@solana/kit` v6 | [`app/`](https://github.com/Panmoni/pushflip/blob/main/app) | UI: connect wallet, render game state, send instructions, react to on-chain events via WebSocket subscriptions. |
| **Wallet adapter ↔ Kit bridge** | Custom adapter | [`app/src/lib/wallet-bridge.ts`](https://github.com/Panmoni/pushflip/blob/main/app/src/lib/wallet-bridge.ts) | Translates between web3.js v1 (used internally by every wallet adapter) and Kit (used by our hooks and instruction builders). The seam where `compileTransaction` output is wrapped as a `VersionedTransaction` for the adapter, then converted back via `@solana/compat` after signing. |

## Data flow: a single round, end to end

```
1.  AUTHORITY ─── initialize ──────► CHAIN
2.  PLAYERS  ─── join_round ───────► CHAIN  (stake FLIP)
3.  DEALER   ─── shuffle (off-chain)
                + Groth16 proof gen (~20s, snarkjs WASM)
4.  DEALER   ─── commit_deck ──────► CHAIN  (proof verified on-chain, ~85K CU)
5.  AUTHORITY ─── start_round ─────► CHAIN
6.  PLAYER A ─── hit ──────────────► CHAIN
                  ↑
                  Merkle proof for leaf 0 (~7,771 CU per hit)
7.  PLAYER A ─── hit ─── ... ─── stay
8.  PLAYER B ─── ... ─── stay
9.  ALL DONE ─── end_round ────────► CHAIN  (payouts to winners)
10. AUTHORITY ─── close_game ──────► CHAIN  (rent recovered)
```

The on-chain program never sees the deck up front. It only sees the **Merkle root** (a 32-byte commitment) at step 4 and individual card reveals at steps 6+, each verified against the stored root. The dealer cannot swap cards mid-game without producing an invalid Merkle proof.

## ZK pipeline

Every deck shuffle in PushFlip is provably fair using zero-knowledge cryptography. We want to prove "the deck was shuffled correctly" without revealing the shuffle order until cards are drawn. That's exactly what ZK-SNARKs do — prove a computation was done correctly without revealing the private inputs.

### The pipeline

```
Circom Circuit ──compile──► R1CS (constraints)
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
              (off-chain)            (~85K compute units)
```

**Circom circuit** ([`zk-circuits/circuits/shuffle_verify.circom`](https://github.com/Panmoni/pushflip/blob/main/zk-circuits/circuits/shuffle_verify.circom)) — Defines the math that must be satisfied: "given this Merkle root (public), I know a permutation (private) that produces a valid 94-card deck." Compiles to ~362K constraints. The circuit enforces three properties:

1. **Valid bijection** — Grand product argument proves every card index appears exactly once
2. **Correct mapping** — Constrained multiplexer proves shuffled cards match the canonical deck at permuted positions
3. **Merkle commitment** — Poseidon Merkle tree binds the shuffled order to a single root hash

**Powers of Tau (`.ptau`)** — A one-time ceremony that generates shared cryptographic randomness. Think of it as "trusted cosmic noise" that makes the proof system work. The ceremony has multiple contributors — as long as *one* was honest, the whole thing is secure. Reusable across any circuit of that size or smaller.

**Proving key (`.zkey`)** — Circuit-specific key generated by combining the ptau with the circuit's constraint system. This is what the dealer needs to create proofs. ~127 MB because the circuit is large.

**Verification key** — The small counterpart extracted from the zkey. This goes on-chain as Rust byte arrays in the Solana program. A few hundred bytes vs the 127 MB proving key.

**Proof generation** — The dealer feeds private inputs (the shuffle permutation) + public inputs (Merkle root, canonical deck hash) into the WASM witness generator + zkey. Out comes a ~256-byte proof that can convince anyone the computation was valid.

**On-chain verification** — The Solana program takes the proof + public inputs + verification key and runs a pairing check via [`alt_bn128` syscalls](glossary.md#alt_bn128-syscalls). ~85K compute units. Returns pass/fail.

### Card reveal flow

After the deck is committed, cards are revealed one at a time:

1. Player calls `hit` — requests the next card
2. Dealer provides the card data + a Merkle proof for that leaf position
3. On-chain program verifies the Merkle proof against the stored root via Solana's [`sol_poseidon` syscall](glossary.md#sol_poseidon-syscall) (~7,771 CU per `hit` — see [Poseidon Stack Warning retrospective](../history/poseidon-stack-warning.md))
4. If valid, the card is added to the player's hand

The Merkle proof guarantees: this card was part of the originally committed deck at that exact position. The dealer cannot swap cards mid-game.

### Mental model

Think of it like a notarized document:

- **ptau** = the notary's credentials (shared, reusable)
- **zkey** = a stamp specific to this type of document
- **proof** = the stamped document itself
- **verification key** = what the court needs to verify the stamp is legit

The magic: the court (on-chain verifier) can confirm the document is valid without ever seeing the original content (the shuffle order).

## Performance profile

All numbers below are **measured empirically** against the live devnet program (`HQLeAQc84WLz8buHM5JAJGBjNJjwc6Fpxts8jSMaW3px`) via [`scripts/smoke-test.ts`](https://github.com/Panmoni/pushflip/blob/main/scripts/smoke-test.ts) — not estimates.

### Per-instruction compute units

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

**A single turn costs you one tenth of one cent.** A 19.45 SOL devnet wallet is good for ~100,000 full games before exhausting tx fees.

### Latency: how long does a turn take?

| Phase | Wall clock |
|---|---|
| Network round-trip per `hit` / `stay` (commitment = `confirmed`) | **~0.6–1.0 s** |
| Solana finalization (only relevant if you require finality) | ~12–13 s |
| Dealer's off-chain Groth16 proof generation (snarkjs WASM, single-threaded, **once per round**) | ~18–30 s |
| On-chain Groth16 verification of that proof | ~1 s |

A turn feels instant. The only noticeable wait is the proof generation that runs **once** at the start of each round — the frontend can mask it behind a "shuffling deck…" animation. After that, every player action is a sub-second click-and-confirm.

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

The on-chain hot path uses Solana's native [`sol_poseidon` syscall](glossary.md#sol_poseidon-syscall) (~7K CU per `hit`) instead of an in-program `light_poseidon` implementation (~211K CU and a stack overflow). See the [Pinocchio Resource Guide §11](../reference/pinocchio-guide.md) for the wrapper that made this possible — it's the closest thing this repo has to a useful open-source contribution upstream. The full incident retrospective is at [Poseidon Stack Warning](../history/poseidon-stack-warning.md).

## Trust model summary

PushFlip's trust model is **single trusted dealer** for the MVP. The ZK proof proves the deck is a *valid* permutation but does NOT prove it was shuffled *randomly*. Players must trust the dealer shuffled honestly.

The roadmap to player-contributed entropy and decentralized dealing is documented as Pre-Mainnet Checklist item 5.0.2 in [`docs/EXECUTION_PLAN.md`](https://github.com/Panmoni/pushflip/blob/main/docs/EXECUTION_PLAN.md). The full security analysis lives in the [Threat Model](threat-model.md).

## Where to go next

| If you want to... | Read |
|---|---|
| Look up a term | [Glossary](glossary.md) |
| Understand the on-chain account byte layout | [GameSession Byte Layout](game-session-byte-layout.md) |
| See the ZK landscape and why Groth16 + Poseidon | [ZK Research](../reference/zk-research.md) |
| Read the Pinocchio reference for on-chain dev | [Pinocchio Guide](../reference/pinocchio-guide.md) |
| Read the Solana Kit reference for client dev | [Solana Kit Guide](../reference/solana-kit-guide.md) |
| Understand the trust assumptions | [Threat Model](threat-model.md) |
| See the full project history | [`docs/EXECUTION_PLAN.md`](https://github.com/Panmoni/pushflip/blob/main/docs/EXECUTION_PLAN.md) |
