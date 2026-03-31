# ZK-Proof Deck Verification: Research & Documentation Guide

> Comprehensive research for PushFlip Phase 6 — ZK-SNARK provably fair deck shuffling on Solana.
> Last updated: 2026-03-30

---

## Table of Contents

1. [Solana ZK Landscape](#1-solana-zk-landscape)
2. [Native Solana ZK Primitives](#2-native-solana-zk-primitives)
3. [Groth16 Verification on Solana](#3-groth16-verification-on-solana)
4. [Poseidon Hashing](#4-poseidon-hashing)
5. [ZK Compression (Light Protocol)](#5-zk-compression-light-protocol)
6. [ZK Coprocessor Approaches (SP1, RISC Zero, Bonsol)](#6-zk-coprocessor-approaches)
7. [Mental Poker & ZK Shuffle Protocols](#7-mental-poker--zk-shuffle-protocols)
8. [Circom Circuit Design for Card Games](#8-circom-circuit-design-for-card-games)
9. [Zypher Network Shuffle SDK](#9-zypher-network-shuffle-sdk)
10. [CU Budget & Transaction Size Constraints](#10-cu-budget--transaction-size-constraints)
11. [Recommended Approach for PushFlip](#11-recommended-approach-for-pushflip)
12. [Complete Resource Index](#12-complete-resource-index)

---

## 1. Solana ZK Landscape

### Overview

Solana has native syscall-level support for ZK proof verification, making it one of the most ZK-capable L1s. Three categories of ZK syscalls are now active on mainnet:

1. **alt_bn128 group operations** — elliptic curve point addition, scalar multiplication, pairing on BN254
2. **alt_bn128 compression** — G1/G2 point compression/decompression (halves proof size to 128 bytes)
3. **Poseidon hash** — ZK-friendly hashing over BN254 curve, activated at epoch 644

These syscalls enable on-chain Groth16 proof verification at under 200K compute units, which is the key enabler for PushFlip's ZK shuffle feature.

### Key Resources

| Resource | URL | Quality | Key Takeaway |
|----------|-----|---------|--------------|
| Helius: ZK Proofs on Solana | https://www.helius.dev/blog/zero-knowledge-proofs-its-applications-on-solana | Excellent, comprehensive, updated | Best single overview of all ZK primitives on Solana — syscalls, CU costs, ZK compression, architecture patterns |
| Tour de ZK (Anagram) | https://github.com/anagrambuild/tour-de-zk | Good, curated link list | Master index of every ZK-related repo, syscall source, and ecosystem project on Solana |
| Solana Compass: Top ZK Projects | https://solanacompass.com/projects/category/research/zk-proofs | Good overview | Lists active ZK projects: Light Protocol, Elusiv, Arcium, Privacy Cash, etc. |
| ZK Architecture Paper | https://arxiv.org/html/2511.00415 | Academic, thorough | Formal treatment of ZK extension patterns on Solana |

---

## 2. Native Solana ZK Primitives

### alt_bn128 Syscalls

**What they are:** Native Solana syscalls for elliptic curve operations on the BN254 (aka alt_bn128) curve. This is the same curve used by Ethereum's precompiles (EIP-196/197), enabling cross-chain proof compatibility.

**Available operations:**
- `sol_alt_bn128_group_op` — Point addition in G1, scalar multiplication in G1, pairing
- `sol_alt_bn128_compression` — Compress/decompress G1 and G2 points

**Availability:** Solana v1.18.x+, active on mainnet-beta.

**Why this matters for PushFlip:** These syscalls are what make Groth16 verification possible on-chain at reasonable CU cost. Without them, you would need to implement pairing operations in BPF bytecode, which would blow the compute budget.

### Poseidon Syscall

**What it is:** A native syscall that computes Poseidon hashes over the BN254 curve.

**Spec:**
- x^5 S-boxes
- Supports 1-12 inputs (width 2-13)
- 8 full rounds + variable partial rounds
- Compatible with Circom's Poseidon implementation (same parameters)

**Why this matters for PushFlip:** The Merkle tree over the shuffled deck uses Poseidon hashing both in-circuit (for the ZK proof) and on-chain (for Merkle proof verification during card reveals). Native syscall support means on-chain Merkle verification is cheap (~6K CU per hash).

### Key Resources

| Resource | URL | Quality | Key Takeaway |
|----------|-----|---------|--------------|
| Solana alt_bn128 source | https://github.com/solana-labs/solana/blob/master/sdk/program/src/alt_bn128/mod.rs | Primary source | Actual syscall implementation |
| alt_bn128 compression | https://github.com/solana-labs/solana/blob/master/sdk/program/src/alt_bn128/compression.rs | Primary source | G1/G2 compression reduces Groth16 proof to 128 bytes |
| Poseidon syscall source | https://github.com/solana-labs/solana/blob/master/sdk/program/src/poseidon.rs | Primary source | Syscall spec |
| BN254 For The Rest Of Us | https://hackmd.io/@jpw/bn254 | Excellent explainer | Plain-language explanation of the BN254 curve and why it matters |
| Helius v1.17 Update | https://www.helius.dev/blog/all-you-need-to-know-about-solanas-v1-17-update | Good context | History of syscall activation |

---

## 3. Groth16 Verification on Solana

### The `groth16-solana` Crate

This is the primary library for on-chain Groth16 proof verification on Solana.

**Key facts:**
- **CU cost:** Under 200,000 compute units for verification
- **Proof size:** 256 bytes uncompressed (3 curve points: A=64, B=128, C=64), 128 bytes with G1/G2 compression
- **Compatibility:** Works with Circom circuits + snarkjs-generated proofs
- **Input format:** u8 arrays in big-endian byte order
- **Audited:** v0.0.1 audited during Light Protocol v3 audit

**Verification workflow:**
1. Generate a Circom circuit and compile it
2. Run trusted setup with snarkjs (Groth16)
3. Generate proofs off-chain with snarkjs or arkworks
4. Export verifying key via `npm run parse-vk` (included JS utility)
5. On-chain: deserialize proof (A, B, C), chunk public inputs into 32-byte segments
6. Instantiate `Groth16Verifier`, call `.verify()`

**Pairing equation verified:**
```
e(A, B) * e(L, gamma) * e(C, delta) = e(alpha, beta)
```

### Alternative: Arkworks-based Approach

The `solana-zk-proof-example` repo demonstrates using Arkworks (`ark-groth16`, `ark-bn254`) directly for proof generation and on-chain verification. Key difference: proofs are generated in Rust instead of JS, and endianness conversion is required when passing proof components to the `alt_bn128_pairing` syscall.

### Key Resources

| Resource | URL | Quality | Key Takeaway |
|----------|-----|---------|--------------|
| groth16-solana crate | https://github.com/Lightprotocol/groth16-solana | Production-quality, audited | Primary library — <200K CU, Circom compatible |
| groth16-solana docs | https://docs.rs/groth16-solana/latest/groth16_solana/ | API reference | Crate documentation |
| Solana ZK Proof Example | https://github.com/wkennedy/solana-zk-proof-example | Excellent tutorial | Full end-to-end: circuit -> proof -> on-chain verify using Arkworks |
| arkworks circom-compat | https://github.com/arkworks-rs/circom-compat | Mature | Rust bindings for Circom R1CS, Groth16 proof + witness gen |
| zkLink Groth16 verifier | https://github.com/zkLinkProtocol/groth16-sol-verifier | Alternative impl | Another Groth16 verifier for Solana |

---

## 4. Poseidon Hashing

### light-poseidon Crate

The standard Poseidon implementation for Solana, created by Light Protocol.

**Key facts:**
- Pre-generated parameters over BN254 curve
- Audited, compatible with Circom (same parameters and constants)
- Works both off-chain (for Merkle tree building) and on-chain (for verification)
- Can work with custom parameters if needed

**Why this matters for PushFlip:** Both the ZK circuit and the on-chain Merkle proof verifier must use identical Poseidon parameters. The light-poseidon crate ensures compatibility between Circom circuits (off-chain proof generation) and on-chain verification via the Poseidon syscall.

### Key Resources

| Resource | URL | Quality | Key Takeaway |
|----------|-----|---------|--------------|
| light-poseidon repo | https://github.com/Lightprotocol/light-poseidon | Production, audited | Standard Poseidon for Solana, BN254, Circom-compatible |
| solana-poseidon crate | https://crates.io/crates/solana-poseidon | Official | Solana's own Poseidon crate wrapping the syscall |
| Poseidon hash info | https://www.poseidon-hash.info/ | Reference | General Poseidon hash documentation |

---

## 5. ZK Compression (Light Protocol)

### Overview

ZK Compression is a state-cost reduction protocol, not directly what PushFlip needs for deck verification. However, understanding it is valuable because:

1. Light Protocol built the tools PushFlip will use (groth16-solana, light-poseidon)
2. The architecture pattern (off-chain state, on-chain hash commitment, ZK proof of correctness) is conceptually similar to PushFlip's deck commitment
3. Understanding CU costs of ZK Compression operations informs PushFlip's budget

**CU breakdown for ZK Compression:**
- ~100K CU for validity proof verification
- ~100K CU for system use
- ~6K CU per compressed account read/write

**Architecture:** Uses Poseidon-based concurrent Merkle trees, Groth16 proofs, and Photon RPC nodes for indexing. State roots stored on-chain; raw data on ledger.

### Key Resources

| Resource | URL | Quality | Key Takeaway |
|----------|-----|---------|--------------|
| ZK Compression docs | https://www.zkcompression.com/home | Official, well-maintained | Full developer docs with 10+ guides |
| Light Protocol repo | https://github.com/Lightprotocol/light-protocol | Primary source | The ZK compression protocol implementation |
| Light Protocol site | https://lightprotocol.com/ | Overview | Project overview and links |
| DeepWiki analysis | https://deepwiki.com/Lightprotocol/light-protocol | Good architectural overview | Deep dive into Light Protocol internals |

---

## 6. ZK Coprocessor Approaches

These are "write Rust, generate proofs" frameworks. They are alternatives to writing Circom circuits. For PushFlip, these are worth considering if you want to write the shuffle logic in pure Rust instead of Circom.

### SP1 (Succinct)

**What it is:** A zkVM that lets you write programs in Rust and generate Groth16 proofs verified on Solana.

**How it works:**
1. Write your shuffle logic as a standard Rust program
2. SP1 compiles and executes it, generating a STARK proof
3. STARK is wrapped into a Groth16 SNARK
4. Verify on-chain using `sp1-solana` crate (leverages BN254 precompiles)

**CU cost:** ~280K CU for verification (higher than raw groth16-solana because of SP1-specific overhead)

**Pros:** Write Rust, not Circom. No circuit constraints to worry about. Unlimited computation off-chain.
**Cons:** Higher CU cost. Not audited for production. Proof generation is slower than native Circom/snarkjs.

### RISC Zero / Bonsol

**What it is:** Bonsol is a Solana-native ZK coprocessor built on RISC Zero's zkVM.

**How it works:**
1. Write ZK programs using RISC Zero tooling (Rust)
2. Register programs with Bonsol
3. Users request execution; provers generate STARK proofs
4. STARKs are wrapped into Groth16 SNARKs
5. Verify natively on Solana at <200K CU

**Key advantage:** Bonsol has a live prover network on Solana. You submit execution requests, provers compete to generate proofs, and results are verified on-chain. This means PushFlip could outsource proof generation to the prover network instead of running its own prover.

**Pros:** Prover network handles proof generation. Write Rust. <200K CU verification.
**Cons:** Dependency on Bonsol infrastructure. Less mature than Circom/snarkjs pipeline.

### Key Resources

| Resource | URL | Quality | Key Takeaway |
|----------|-----|---------|--------------|
| SP1 Solana blog post | https://blog.succinct.xyz/solana-sp1/ | Excellent | Official guide to using SP1 on Solana |
| sp1-solana repo | https://github.com/succinctlabs/sp1-solana | Primary source | Crate + examples for SP1 Groth16 verification |
| sp1-solana crate | https://crates.io/crates/sp1-solana | Crate registry | Latest version info |
| Bonsol docs | https://bonsol.sh/ | Good | Full Bonsol developer documentation |
| Bonsol: What is Bonsol | https://bonsol.sh/docs/explanation/what-is-bonsol | Good explainer | Architecture and flow |
| Bonsol tutorial | https://bonsol.sh/docs/tutorials/a-taste-of-bonsol | Tutorial | Getting started guide |
| Bonsol repo | https://github.com/bonsol-collective/bonsol | Primary source | Source code |
| risc0 repo | https://github.com/risc0/risc0 | Primary source | RISC Zero zkVM |
| risc0-solana repo | https://github.com/risc0/risc0-solana | Integration | RISC Zero Solana verifier |
| Anagram: Bonsol deep dive | https://blog.anagram.xyz/bonsol-verifiable-compute/ | Excellent analysis | Technical architecture analysis |

---

## 7. Mental Poker & ZK Shuffle Protocols

This section covers the cryptographic theory behind provably fair card games, which is the academic foundation for PushFlip's ZK feature.

### The Mental Poker Problem

**Origin:** Formulated in 1979 by Shamir, Rivest, and Adleman. The question: can you play a fair card game over a communication channel with no trusted third party?

**Core requirements:**
1. **Hiding card values** — no player can see another's cards
2. **Fair shuffling** — no player or coalition can control the shuffle outcome
3. **Cheat prevention** — each step is proven in zero knowledge

### The Barnett-Smart Protocol (2003)

The foundational modern protocol, improved by Bayer-Groth (2012). Uses n-out-of-n threshold encryption:

1. All players generate key pairs and compute an aggregate public key
2. Cards are "masked" — encrypted under the aggregate public key with randomness
3. Players sequentially "remask" — replace the encryption label without knowing the underlying card
4. `shuffle_and_remask` — each player permutes card positions AND remasks simultaneously
5. To reveal a card to one player, all OTHER players partially decrypt, leaving only the recipient's encryption layer
6. The recipient privately decrypts

**Why all players must shuffle:** "Unless all players collude, the shuffle is fair."

### zkShuffle (Mental Poker on SNARK)

A practical implementation targeting Ethereum. Key design:

**Functions:**
1. `setup` — Each player generates secret/public key pair; system computes aggregate public key
2. `shuffle_encrypt` — Players sequentially shuffle + encrypt using ElGamal on Baby Jubjub curve
3. `decrypt` / `decrypt_post` — Reveal cards with ZK proof of correct decryption

**Circuit specs (Circom):**
- `shuffle_encrypt` circuit: ~87,308 R1CS constraints, ~4.5 sec proof generation in browser
- `decrypt_post` circuit: ~1,522 R1CS constraints, ~0.1 sec proof generation
- Uses Groth16 proof system

**ElGamal encryption (additive, on elliptic curve):**
```
Encrypt: c1 = m[1] + r*g, c2 = m[2] + r*pk
Decrypt: m = c2 - sk*c1
```

Homomorphic property ensures encryption/decryption order does not matter.

### Key Resources

| Resource | URL | Quality | Key Takeaway |
|----------|-----|---------|--------------|
| Geometry: ZK Mental Poker Library | https://hackmd.io/@nmohnblatt/SJKJfVqzq | Excellent, technical | Full protocol explanation with Rust/Arkworks implementation |
| zkShuffle: Mental Poker on SNARK | https://hackmd.io/@ZDZ-B3ktQlOiBE4iqOXVlg/BJA7Zoqns | Excellent, practical | Circuit specs, CU costs, ElGamal details for card games |
| zkShuffle docs | https://zk-shuffle-docs.vercel.app/ | Good reference | Documentation for the zkShuffle library |
| zkHoldem | https://zkholdem.xyz/ | Live product | Working ZK poker game (Ethereum) |
| zkHoldem docs | https://zkholdem.gitbook.io/documentation/introduction/zkholdem-as-a-solution | Good | How zkHoldem solves the mental poker problem |
| ZK Multiplayer Card Game | https://github.com/abhishek-01k/zk-multiplayer-card-game | Example code | Open-source ZK card game implementation |
| Onchain ZK Shuffle Texas HoldEm | https://ethglobal.com/showcase/onchain-zk-shuffle-texas-holdem-wuc8u | Hackathon project | ETHGlobal showcase — practical implementation |
| O1 Labs: ZK Proofs for Games | https://www.o1labs.org/blog/zero-knowledge-proofs-for-games-f8b690a2c1ef | Good overview | General ZK gaming patterns |
| How to create on-chain poker with zkSNARK | https://www.chaincatcher.com/en/article/2082764 | Good tutorial | Step-by-step guide |
| Poker is Hard (Cryptography Blog) | https://blog.cryptographyengineering.com/2012/04/02/poker-is-hard-especially-for/ | Classic, accessible | Why mental poker is genuinely difficult |
| ZK Poker Circom Circuit | https://medium.com/coinmonks/zk-poker-a-simple-zk-snark-circuit-8ec8d0c5ee52 | Good intro | Simple Circom circuit proving a player holds a pair |

---

## 8. Circom Circuit Design for Card Games

### Overview

Circom is the most mature framework for writing ZK circuits that verify on Solana via Groth16. The pipeline is:

```
Circom circuit (.circom)
    -> Compile to R1CS + WASM
    -> Trusted setup with snarkjs (generates proving key + verification key)
    -> Generate witness (off-chain, with private inputs)
    -> Generate Groth16 proof (off-chain, with snarkjs or arkworks)
    -> Export verification key to Rust (npm run parse-vk)
    -> Verify on-chain with groth16-solana crate
```

### Circuit Design Patterns for Card Shuffles

**PushFlip's circuit needs to prove:**
1. The dealer knows a valid permutation of 94 cards
2. Applying that permutation to the canonical deck produces a shuffled deck
3. The Merkle tree built from the shuffled deck has the claimed root

**Constraint breakdown (estimated):**
- Permutation validity (bijection check): ~94 range checks + uniqueness
- Deck application: ~94 lookups
- Poseidon hashing per leaf: ~300 constraints * 94 leaves = ~28,200
- Merkle tree construction (7 levels): ~300 * (94 internal nodes) = ~28,200
- **Total: ~50K-80K constraints** — well within Groth16's practical range

**Available Circom libraries:**
- `circomlib` — Poseidon hash, comparators, bitwise operations
- `circom-ecdsa` — if ElGamal on elliptic curves is needed
- Custom: permutation matrix validation, Fisher-Yates verification

### Alternative: Rust-based Circuit with Arkworks

Instead of Circom, you can define the circuit in Rust using:
- `ark-relations` for constraint system
- `ark-groth16` for proving/verification
- `ark-bn254` for the BN254 curve
- `arkworks-rs/circom-compat` for bridging to Circom circuits

This approach keeps everything in Rust (matching PushFlip's stack) but has a steeper learning curve than Circom.

### Key Resources

| Resource | URL | Quality | Key Takeaway |
|----------|-----|---------|--------------|
| Circom/snarkjs docs | https://docs.iden3.io/circom-snarkjs/ | Official, comprehensive | Full Circom + snarkjs documentation |
| snarkjs repo | https://github.com/iden3/snarkjs | Primary source | Supports Groth16, PLONK, FFLONK |
| arkworks circom-compat | https://github.com/arkworks-rs/circom-compat | Mature | Rust bindings for Circom R1CS |

---

## 9. Zypher Network Shuffle SDK

### Overview

Zypher Network provides a production ZK shuffle SDK specifically for card/board games, packaged as WASM + NPM.

**Key features:**
- Optimized WASM-based shuffling in the browser
- Precompiled contracts for on-chain verification
- Supports application-specific Plonk circuits compiled to WASM
- Used by 30+ games, 3M+ users
- One of the first middleware providers to support SVM (Solana)

**Relevance to PushFlip:** Zypher's SDK could potentially be used directly instead of building a custom Circom circuit. However, it introduces a dependency on Zypher's infrastructure, and the degree of Solana SVM support should be verified.

### Key Resources

| Resource | URL | Quality | Key Takeaway |
|----------|-----|---------|--------------|
| Zypher Shuffle SDK docs | https://docs.zypher.network/zk/secret/sdk-shuffle/ | Official | SDK usage and integration |
| Zypher ZK overview | https://docs.zypher.network/zk/ | Official | Full ZK engine documentation |
| Zypher TCG Workshop | https://docs.zypher.network/blog/workshop-tcg/ | Tutorial | Building a trading card game with Zypher |
| Zypher Network GitHub | https://github.com/zypher-network | Source code | 18 repos |
| Zoo Clash (example game) | https://github.com/rotcan/zypher-zoo-clash | Example | Full TCG built with Zypher shuffle SDK |
| Zypher White Paper Analysis | https://www.chaincatcher.com/en/article/2124212 | Deep dive | Technical architecture of Secret Engine |

---

## 10. CU Budget & Transaction Size Constraints

### Compute Unit Budget

| Operation | CU Cost | Source |
|-----------|---------|--------|
| Groth16 verification (groth16-solana) | <200,000 CU | Light Protocol |
| Groth16 verification (sp1-solana) | ~280,000 CU | Succinct |
| Groth16 verification (Bonsol) | <200,000 CU | Bonsol docs |
| ZK Compression validity proof | ~100,000 CU | Helius |
| Per-account compressed read/write | ~6,000 CU | Helius |
| Default CU per non-builtin instruction | 200,000 CU | Solana |
| Max CU per transaction | 1,400,000 CU | Solana |
| Poseidon hash (syscall) | ~5,000-10,000 CU (est.) | Based on syscall costs |

**Implication for PushFlip:**
- `commit_deck` (Groth16 verify): ~200K CU — fits in a single instruction with budget to spare
- `hit` (Merkle proof verify, 7 Poseidon hashes): ~50K CU — very comfortable
- Both operations fit well within Solana's 1.4M CU transaction limit
- You must request increased CU budget via `SetComputeUnitLimit` for the commit_deck instruction

### Transaction Size

| Constraint | Value |
|------------|-------|
| Current max transaction size | 1,232 bytes |
| Proposed larger transactions (SIMD-0296) | 4,096 bytes |
| Groth16 proof (compressed) | 128 bytes |
| Groth16 proof (uncompressed) | 256 bytes |
| Merkle proof (7 levels, Poseidon) | 224 bytes (7 x 32) |
| Card data + leaf index | ~8 bytes |

**Implication for PushFlip:**
- `commit_deck`: 128 bytes (proof) + 32 bytes (merkle root) + accounts + overhead = fits comfortably
- `hit`: 224 bytes (merkle proof) + 8 bytes (card) + accounts + overhead = fits comfortably
- No need for address lookup tables or multi-transaction patterns

---

## 11. Recommended Approach for PushFlip

### Decision: Circom + Groth16 + groth16-solana

After evaluating all options, the recommended stack for PushFlip Phase 6 is:

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Circuit language | **Circom** | Most mature, best tooling, huge community, directly compatible with groth16-solana |
| Proof system | **Groth16** | Smallest proof (128 bytes compressed), cheapest verification (<200K CU), best Solana support |
| On-chain verifier | **groth16-solana** | Audited, production-proven, used by Light Protocol |
| Hashing | **Poseidon** (light-poseidon + syscall) | ZK-friendly, native Solana syscall, Circom-compatible parameters |
| Proof generation | **snarkjs** (off-chain dealer) | Standard tool for Circom Groth16 proofs |
| Merkle tree | **Custom using light-poseidon** | 7-level binary tree, 94 leaves |

### Why NOT the alternatives:

| Alternative | Rejection Reason |
|-------------|-----------------|
| SP1/Succinct | Higher CU cost (~280K), not audited, overkill for a simple shuffle circuit |
| Bonsol/RISC Zero | Infrastructure dependency, less mature, PushFlip's circuit is simple enough for Circom |
| Zypher SDK | External dependency, unclear Solana SVM support maturity, less portfolio-impressive than custom circuit |
| PLONK/halo2 | Larger proofs, more expensive on-chain verification, no Solana-native verifier |
| Full Mental Poker (zkShuffle) | Massive overkill — PushFlip has a trusted dealer (The House), not a peer-to-peer poker game. Full mental poker requires every player to shuffle, generating 87K-constraint proofs per player per round. PushFlip only needs to prove the single dealer's shuffle is valid. |

### Architecture

```
                    PushFlip ZK Architecture

    ┌─────────────────────────────────────────────────────┐
    │              Off-Chain Dealer Service                 │
    │                                                     │
    │  1. Generate random seed (CSPRNG)                   │
    │  2. Fisher-Yates shuffle 94-card canonical deck     │
    │  3. Build Poseidon Merkle tree over shuffled deck   │
    │  4. Generate Groth16 proof via snarkjs:             │
    │     - Circuit proves valid permutation              │
    │     - Circuit proves Merkle root correctness        │
    │  5. Submit (merkle_root, compressed_proof) on-chain │
    └──────────────────────┬──────────────────────────────┘
                           │
                           ▼
    ┌─────────────────────────────────────────────────────┐
    │              On-Chain (Anchor Program)                │
    │                                                     │
    │  commit_deck(merkle_root, proof):                   │
    │    - Verify Groth16 proof via groth16-solana        │
    │    - CU cost: ~200K                                 │
    │    - Store merkle_root in GameSession               │
    │    - Set deck_committed = true                      │
    │                                                     │
    │  hit(card_data, merkle_proof, leaf_index):           │
    │    - Verify merkle_proof via Poseidon syscall        │
    │    - CU cost: ~50K                                  │
    │    - Verify leaf_index == draw_counter               │
    │    - Process card, increment draw_counter            │
    └─────────────────────────────────────────────────────┘
```

### Implementation Sequence

1. **Learn Circom basics** — write a toy circuit, generate proof with snarkjs, verify locally
2. **Design the shuffle circuit** — permutation validation + Poseidon Merkle tree
3. **Implement Merkle tree** — shared Rust library using light-poseidon for both off-chain and on-chain
4. **Set up trusted ceremony** — generate proving and verification keys for the circuit
5. **Build dealer service** — shuffle engine + snarkjs proof generation + commitment publisher
6. **Modify Anchor program** — add `commit_deck` with groth16-solana verifier, modify `hit` for Merkle proofs
7. **Integration test** — end-to-end: shuffle -> prove -> commit -> draw -> verify
8. **Feature flag** — `randomness_mode` field for graceful migration from slot-hash

### Estimated Circuit Specs

```
Public inputs:
  - merkle_root (BN254 field element)
  - canonical_deck_hash (constant, BN254 field element)

Private inputs (witness):
  - permutation[94] (indices 0-93)
  - random_seed (BN254 field element)

Constraints:
  - Permutation is valid bijection: ~2,000
  - Apply permutation to canonical deck: ~1,000
  - Poseidon hash per leaf (94 leaves): ~28,000
  - Build Merkle tree (93 internal nodes): ~28,000
  - Total: ~59,000 constraints

Proof generation time: ~3-8 seconds (depending on hardware)
Proof size: 128 bytes (compressed Groth16)
Verification CU: <200,000
```

### Key Implementation Notes

1. **Trusted setup:** Groth16 requires a per-circuit trusted setup. For a portfolio project, a solo ceremony is fine. Document the trust assumption in the README. For production, you would use a multi-party computation ceremony.

2. **Endianness:** Solana's `alt_bn128_pairing` expects specific byte ordering. The groth16-solana crate handles this, but if using arkworks directly, you must convert endianness manually (see solana-zk-proof-example).

3. **Transaction size:** Both `commit_deck` (128 bytes proof + 32 bytes root) and `hit` (224 bytes Merkle proof + card data) fit within Solana's 1,232-byte transaction limit.

4. **CU budgeting:** Request 300K CU for `commit_deck` transactions (200K verify + overhead). Default 200K for `hit` transactions.

5. **Circom + snarkjs version pinning:** Pin Circom compiler version and snarkjs version. The circuit, trusted setup, and proof generation must all use compatible versions.

6. **light-poseidon compatibility:** Ensure the Circom circuit's Poseidon parameters match light-poseidon's BN254 implementation. Both use the same constants, but verify in tests.

---

## 12. Complete Resource Index

### Core Libraries (Must-Use)

| Library | URL | Purpose |
|---------|-----|---------|
| groth16-solana | https://github.com/Lightprotocol/groth16-solana | On-chain Groth16 verification |
| light-poseidon | https://github.com/Lightprotocol/light-poseidon | Poseidon hashing (off-chain + on-chain) |
| solana-poseidon | https://crates.io/crates/solana-poseidon | Solana Poseidon syscall wrapper |
| snarkjs | https://github.com/iden3/snarkjs | Groth16 proof generation (JS) |
| Circom | https://docs.iden3.io/circom-snarkjs/ | Circuit language |
| circomlib | (included with Circom) | Standard Circom components (Poseidon, comparators, etc.) |

### Reference Implementations

| Repo | URL | Relevance |
|------|-----|-----------|
| solana-zk-proof-example | https://github.com/wkennedy/solana-zk-proof-example | Full Groth16 tutorial for Solana |
| Light Protocol | https://github.com/Lightprotocol/light-protocol | Architecture patterns, Merkle trees |
| Light breakpoint workshop | https://github.com/Lightprotocol/breakpoint-workshop | Hands-on ZK on Solana workshop |
| zk-solana-mobile-verifier | https://github.com/greg-nagy/zk-solana-mobile-verifier | End-to-end PoC with React Native |
| sion crates-solana | https://github.com/umi-ag/sion/tree/alpha/crates-solana | Multiple proof system examples |

### Mental Poker / Card Game References

| Resource | URL | Type |
|----------|-----|------|
| Geometry Mental Poker Library | https://hackmd.io/@nmohnblatt/SJKJfVqzq | Protocol + Rust impl |
| zkShuffle Mental Poker on SNARK | https://hackmd.io/@ZDZ-B3ktQlOiBE4iqOXVlg/BJA7Zoqns | Circuit specs |
| zkShuffle docs | https://zk-shuffle-docs.vercel.app/ | SDK docs |
| zkHoldem | https://zkholdem.xyz/ | Live product |
| ZK Poker Circom Circuit | https://medium.com/coinmonks/zk-poker-a-simple-zk-snark-circuit-8ec8d0c5ee52 | Tutorial |
| ZK Multiplayer Card Game | https://github.com/abhishek-01k/zk-multiplayer-card-game | Open source |
| Zypher Shuffle SDK | https://docs.zypher.network/zk/secret/sdk-shuffle/ | Production SDK |

### ZK Coprocessors (Alternative Approaches)

| Tool | URL | When to Use |
|------|-----|-------------|
| SP1 Solana | https://github.com/succinctlabs/sp1-solana | If you want to write Rust instead of Circom |
| Bonsol | https://bonsol.sh/ | If you want prover network + RISC Zero |
| RISC Zero | https://github.com/risc0/risc0 | General-purpose zkVM |

### Background Reading

| Resource | URL | Topic |
|----------|-----|-------|
| Helius ZK Proofs on Solana | https://www.helius.dev/blog/zero-knowledge-proofs-its-applications-on-solana | Comprehensive overview |
| Tour de ZK | https://github.com/anagrambuild/tour-de-zk | Master link index |
| BN254 For The Rest Of Us | https://hackmd.io/@jpw/bn254 | Curve explanation |
| Groth16 Explained (RareSkills) | https://rareskills.io/post/groth16 | Groth16 deep dive |
| Poker is Hard (Crypto Blog) | https://blog.cryptographyengineering.com/2012/04/02/poker-is-hard-especially-for/ | Why mental poker is hard |
| Bayer-Groth Shuffle Proof | https://eprint.iacr.org/2005/246.pdf | Academic paper on verifiable shuffles |
| ZK Architecture on Solana | https://arxiv.org/html/2511.00415 | Academic paper |
