---
title: Glossary
diataxis_type: reference
last_compiled: 2026-04-11
related_wiki:
  - architecture/index.md
  - architecture/game-session-byte-layout.md
  - reference/faq.md
tags:
  - terminology
---

# Glossary

The single source of truth for terminology used across the PushFlip docs and code. If a term appears in another wiki page or in source comments and you don't recognize it, look here first. Linked from the architecture overview, the FAQ, and the contributor guide.

Terms are listed in dependency order: cryptographic primitives first, then on-chain accounts, then game roles, then gameplay actions.

## Cryptographic primitives

### Groth16 proof

A Groth16 zero-knowledge succinct non-interactive argument of knowledge (zk-SNARK). PushFlip uses Groth16 to prove "the dealer knows a valid permutation that produces the committed deck" without revealing the permutation itself. The proof is ~256 bytes regardless of circuit size, and on-chain verification costs ~85K compute units via Solana's [`alt_bn128` syscalls](#alt_bn128-syscalls). The Circom circuit lives at [`zk-circuits/circuits/shuffle_verify.circom`](../../../zk-circuits/circuits/shuffle_verify.circom). For the full landscape comparison and rationale for choosing Groth16 over alternatives (Plonk, Halo2, etc.), see the [ZK Research](../reference/zk-research.md) survey.

### Poseidon hash

A ZK-friendly cryptographic hash function specifically designed for use inside arithmetic circuits (where SHA-256 would be prohibitively expensive). PushFlip uses Poseidon for the Merkle tree that commits the shuffled deck — Merkle inclusion proofs can then be verified inside the same Groth16 circuit cheaply. On-chain verification of individual Merkle proofs (per `hit` instruction) uses Solana's native [`sol_poseidon` syscall](#sol_poseidon-syscall) at ~7,771 CU per call.

### Poseidon Merkle root

A 32-byte cryptographic commitment to the entire shuffled deck. After the dealer shuffles, every card is hashed into a leaf of a Poseidon Merkle tree, the leaves are hashed pairwise up to a single root, and that root is stored on-chain in the [`GameSession`](#gamesession) account via the `commit_deck` instruction. Subsequent `hit` calls reveal individual cards and prove via Merkle inclusion that they came from the originally-committed deck — the dealer cannot swap cards mid-game without producing an invalid proof.

### Canonical deck

The unshuffled, agreed-upon ordering of all 94 cards in a PushFlip game. The Circom circuit takes the canonical deck as a public input and proves that the shuffled deck (the private input) is a valid permutation of it. The hash of the canonical deck is also a public input — the on-chain verifier checks both the Merkle root commitment and the canonical hash against the proof.

### `alt_bn128` syscalls

Solana's native syscalls for elliptic curve operations on the BN254 (also called alt_bn128) curve. PushFlip uses them inside `commit_deck` to perform the Groth16 pairing check. Without these syscalls, on-chain Groth16 verification would be prohibitively expensive (>1M compute units); with them, it costs ~85K CU. See the [Pinocchio Guide](../reference/pinocchio-guide.md) for the Rust wrapper.

### `sol_poseidon` syscall

Solana's native syscall for Poseidon hashing on the BN254 curve. PushFlip's on-chain Merkle proof verification (called from `hit`) uses this syscall, which costs ~7,771 CU per `hit`. The historical alternative was `light_poseidon` (an in-program implementation) which consumed ~211K CU AND overflowed the BPF stack frame. The migration to the syscall is the closest thing this repo has to a portfolio-positive open-source contribution. The full retrospective is at [Poseidon Stack Warning](../history/poseidon-stack-warning.md).

## On-chain accounts

### PDA (Program Derived Address)

A Solana account address derived deterministically from a program ID + a list of seeds, with no associated private key. PDAs let a program own and sign for accounts without needing to manage keypairs. PushFlip's two main PDAs are the [`GameSession`](#gamesession) (seeds: `[b"game", &game_id.to_le_bytes()]`) and the per-player [`PlayerState`](#playerstate) (seeds: `[b"player_state", game_pda.as_ref(), player.key().as_ref()]`). The byte layout of the GameSession PDA is documented at [GameSession Byte Layout](game-session-byte-layout.md).

### GameSession

The top-level on-chain account for a single game. A 512-byte PDA holding the game's authority addresses (authority/dealer/house/treasury), the four player slots, the pot amount, the round state (active/inactive, deck committed or not), the Poseidon Merkle root once the deck is committed, the treasury fee in basis points, and metadata for rent recovery. The full byte-by-byte layout is at [GameSession Byte Layout](game-session-byte-layout.md). One GameSession per `game_id`.

### PlayerState

A 256-byte PDA per (player, game) pair. Created when a player calls `join_round`, holds their hand of revealed cards, their score, their staked amount, their seat index, their `is_active` flag, and a few flags for power-up burns. Closed via `leave_game` when they exit, refunding the rent.

### Vault

The SPL token account that holds staked `$FLIP` for a single game. Owned by the [`GameSession`](#gamesession) PDA (so only the program can move funds out). Created at game initialization. The presence of a token account at the canonical vault PDA is what makes [`vault_ready`](#vault_ready) resolve to true at runtime.

### `vault_ready`

A runtime-derived boolean (NOT a stored field). The on-chain program determines `vault_ready` by checking whether an SPL token account exists at the [`vault`](#vault) PDA address. If it does not exist, `join_round` validates `MIN_STAKE` but skips the actual token transfer (the player joins with `staked_amount=0`). This is the design that lets `scripts/init-game.ts` create a usable test game without setting up a real token account first. See open-brain memory `#166` for the gotcha.

## Game roles

### Authority

The wallet that initialized the [`GameSession`](#gamesession) and is allowed to call administrative instructions like `start_round`, `end_round`, and `close_game`. Stored as the first pubkey in the GameSession account. In production this should be a multisig or a governance account; in test scripts (like `init-game.ts`) it's the same wallet that fills every other role.

### Dealer

The off-chain service that shuffles the deck, generates the Groth16 proof, calls `commit_deck` (must sign as the dealer), and serves Merkle proofs for each card on `hit`. Lives at [`dealer/`](../../../dealer/). The dealer's identity is stored as a pubkey in the [`GameSession`](#gamesession) and validated on every signature. **The dealer is the only entity in the system that knows the deck preimage before reveal** — this is the single trust assumption documented in the [Threat Model](threat-model.md).

### House

The AI opponent that plays against humans. Has its own seat in the game's [`turn_order`](#turn_order). Implementation: see [`house-ai/`](../../../house-ai/) (in-progress as of Phase 4). The House's pubkey is stored as identity-only in the GameSession — it never signs on its own, instead the AI service builds and submits transactions on the House's behalf via a separate signing account.

### Treasury

The address that receives the per-game rake (default 2% = 200 basis points, configurable per game via `treasury_fee_bps` at initialization). Stored as a pubkey in the GameSession account. Identity-only — the treasury never signs.

## Gameplay actions

### `commit_deck`

The instruction the dealer calls after shuffling. Submits the [Poseidon Merkle root](#poseidon-merkle-root) + the [Groth16 proof](#groth16-proof) to the program. The program verifies the proof on-chain via [`alt_bn128` syscalls](#alt_bn128-syscalls) (~85K CU) and stores the root if valid. Must be called before `start_round`.

### `hit`

The instruction a player calls during their turn to draw the next card. The player's transaction includes the revealed card data + a Merkle inclusion proof. The on-chain program verifies the proof against the stored root via [`sol_poseidon`](#sol_poseidon-syscall) (~7,771 CU) and adds the card to the player's hand. If the player busts (sum exceeds the threshold), `is_active` flips to false.

### `stay`

The instruction a player calls to lock in their current score and end their turn. No card is drawn. The next player in `turn_order` becomes active.

### `scry`

A power-up burn: the player burns some `$FLIP` to peek at the next card without committing to drawing it. Off-chain only sees the card via a `ScryResult` event filtered to that player.

### `second_chance`

A power-up burn: after busting, the player burns some `$FLIP` to re-enable their turn (their bust is forgiven for one card).

### `$FLIP` token

The SPL token that drives the PushFlip economy. Decimals: 9. Used for staking (deposited into the [`vault`](#vault) on `join_round`), winning (paid out on `end_round`), and burning for power-ups ([`scry`](#scry), [`second_chance`](#second_chance)). The devnet test mint lives at `2KqqB7SRVaD98ZbVaiRWirxbaJv5ryNzkDRGweBZVryF` — anyone with the test mint authority can mint test FLIP for development.

### `MIN_STAKE`

A constant in [`@pushflip/client`](../../../clients/js/src/) that defines the minimum number of `$FLIP` base units required to call `join_round`. Validated on the client side by `useGameActions.joinRound` and on the chain side by the program. Defending against negative bigints and other footgun inputs is the same pattern documented in open-brain memory `#167`.

### `turn_order`

A 4-element array of pubkeys inside the [`GameSession`](#gamesession) account. Defines the seat order for the game. Filled progressively as players call `join_round` (the first joiner takes seat 0, etc.). Empty seats are zero-padded. The `currentTurnIndex` field points at the active player; on `stay`, the index advances modulo `playerCount` to the next still-active player.
