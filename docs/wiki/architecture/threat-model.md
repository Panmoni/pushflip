---
title: Threat Model
diataxis_type: explanation
last_compiled: 2026-04-15
related_wiki:
  - architecture/index.md
  - reference/faq.md
  - reference/zk-research.md
---

# Threat Model

This page is the consolidated security story for PushFlip at its **current devnet phase**. It is deliberately honest about what the program protects against, what it does not, what is mitigated, what is deferred to mainnet, and what is permanently out of scope.

Update this page whenever the trust model changes — most importantly when [Pre-Mainnet 5.0.2](https://github.com/Panmoni/pushflip/blob/main/docs/EXECUTION_PLAN.md) (threshold randomness / multi-party dealer) lands.

## At a glance

- **Authority = operator of record.** Controls game lifecycle + fee % + the irreversible "flip to real-stake" switch (`init_vault`). Single point of failure for any given game.
- **Dealer = single trusted shuffle oracle.** Today. Post-5.0.2 this becomes a threshold protocol.
- **ZK proves *valid permutation*, not *random shuffle*.** The dealer picks the permutation — the circuit only verifies there are no duplicates and the Merkle commitment matches. If the dealer is compromised, it can stack the deck.
- **`vault_ready` degrades gracefully.** Missing token account at the vault PDA → stake transfers silently skip + player records `staked_amount=0`. No failure, no griefing path.
- **15 heavy-duty reviews shipped.** Every one caught ≥1 structural bug the unit tests missed, including one Critical exploit (cross-game claim) + two Critical authority-gating misses. See [review catches](#heavy-duty-review-catches) below.

## Trust assumptions per role

| Role | Trusted to | Blast radius if compromised | Current gating |
|---|---|---|---|
| **Authority** | Initialize games, set `treasury_fee_bps`, call `init_vault` (irreversible), run `start_round`/`end_round` | Per-game: can flip any game it owns into real-stake mode, change fees, drain the vault via the end-of-round payout path. Cross-game: none — authority is per-game. | Authority signature required on every state-changing instruction that carries authority risk. The cross-check `gs.authority == payer.address()` is enforced on `init_vault` (heavy-duty review #5 H1), `start_round`, `end_round`, `close_game`, `close_bounty_board`. |
| **Dealer** | Generate a fresh unpredictable permutation for each round; submit a valid Groth16 proof + Merkle commitment | **Material.** A compromised or malicious dealer can stack the deck for any player it chooses. The Groth16 proof only asserts *valid permutation*, not *random*. See [ZK assumptions](#what-the-zk-proof-does-and-does-not-prove) below. | Today: trusted-dealer assumption. Mitigation deferred to Pre-Mainnet 5.0.2 (threshold randomness protocol). |
| **House** | The AI player. Plays like any other player: joins rounds, hits, stays, leaves. Has no special permissions at the program level. | If the House AI's strategy is broken, the game is unfair to humans but no money leaks outside of the pot. The House is *not* the dealer and cannot influence the shuffle. | Standard player account — same gates as any human. |
| **Treasury** | A pubkey set once at `initialize` (no on-chain re-binding). Receives `rake = pot × treasury_fee_bps / 10_000` on every round payout. | If the treasury address is wrong (typo at `initialize`, or the owning wallet is compromised), rake accumulates somewhere unintended. Not recoverable by the program. | Careful review of `initialize` arguments before broadcast. On-chain the `treasury_token_account` is the account the rake transfers to, and the program only writes to whatever address was baked in at init. |
| **`$FLIP` mint authority** | Currently the dedicated faucet keypair `5vzyxxJ1NwoN5PgX1p2zCavbxc7mugLMdF7At5syGfA6` (transferred from the operator's CLI wallet 2026-04-15 via tx `5GR6KHASrRtRPqbqCwgXbk3nH3vBKZaLRXpMRTegXKuF9guHmv6My5bKifqCGNvnzP7z56TcNBPRfTfkT8pHN1f1` — Pre-Mainnet 5.0.7 deploy prep). Trusted to mint test `$FLIP` to faucet-requesting wallets via the Hono service in [faucet/](https://github.com/Panmoni/pushflip/blob/main/faucet/). | Compromise → unlimited test-`$FLIP` minting. **Zero monetary value** on devnet. The blast radius is "the visible supply of test-`$FLIP` becomes meaningless"; the on-chain game program is unaffected, and no other authority/key is at risk because the new keypair is dedicated. | Faucet keypair lives only on the operator's local dev machine + on the faucet host (mode 0600) + in a password manager backup. Transferred away from the CLI wallet specifically so a compromised faucet doesn't cascade into the operator's full devnet wallet. Promotion to a permanent mint with metadata + multisig authority is tracked as Pre-Mainnet 5.0.6. |
| **Players** | Sign their own transactions. That's it. | Losing a keypair = losing that wallet's $FLIP + SOL. No cross-player exposure. | Standard wallet self-custody. |

## Attack surface

Every state-changing on-chain entry point, and what validates each:

| Instruction | Risky inputs | What validates |
|---|---|---|
| `initialize` | `authority`, `dealer`, `house`, `treasury`, `token_mint` (all set here, mostly immutable after) | Authority is the sole signer. Player counts start at 0 (design fix — House is NOT auto-added; verified live on devnet, first smoke-test 2026-04-09). |
| `init_vault` | The vault PDA + token_mint | Authority signature check (review #5 H1). SPL `initialize_account_3` creates a token account *owned by the vault PDA itself* — only the program can sign to move tokens out. Irreversible: there is no `close_vault`. |
| `join_round` | `stake_amount` (u64), player's ATA | `MIN_STAKE` check (100 $FLIP). Player-not-already-joined check (`PlayerAlreadyJoined`). `vault_ready` branch: if the vault token account doesn't exist, silently skip the transfer and record `staked_amount = 0`. |
| `commit_deck` | A Groth16 proof + Merkle root + canonical hash | On-chain verification via Solana's `alt_bn128` syscalls. The verifying key is pinned by a snapshot fingerprint test in [`program/src/zk/verifying_key.rs`](https://github.com/Panmoni/pushflip/blob/main/program/src/zk/verifying_key.rs) — a different VK fails the test at compile time. **Dealer signature required** (only the game's dealer can commit). |
| `hit` | `card_value`, `card_type`, `card_suit`, 7-depth Merkle proof, `leaf_index` | Merkle proof verified against the committed root via Solana's native `sol_poseidon` syscall (~7.7K CU). The proof ties the revealed card to the committed deck. Turn order + `round_active` + `is_active` all checked. |
| `stay` | None | Turn order + `round_active` + `is_active` checked. Score is computed from the player's hand in program code and written to `PlayerState`. |
| `end_round` | `winner_index` (implicit — the program recomputes) | Authority signature. Walks `PlayerState` for the highest score among `STAYED` players. Payout uses `vault` as SPL signer via PDA seeds. |
| `claim_bounty` | `bounty_index` (u8) | **Cross-game `player_state` verification** (review #5 C1 — prevents a player in both game A and game B from claiming a game B bounty with their game A qualifications). Win-condition check matches `bounty_type`. Refuses mid-round claims (review #5 M1). |
| `close_game` / `close_bounty_board` | None | Authority signature. Cross-reference checks standardized on `InvalidPda` for bounty_board↔game_session pairing (review #5 M3). |

Every signer is a signer (we never derive signing authority from account ownership alone). Every PDA is verified against a known seed derivation before it's trusted. Every SPL transfer uses either a signer's direct authority OR a PDA signer with seeds derived from the game — never from player-controlled data.

## What the ZK proof does and does not prove

**Proves** (via [`zk-circuits/circuits/shuffle_verify.circom`](https://github.com/Panmoni/pushflip/blob/main/zk-circuits/circuits/shuffle_verify.circom)):

- **Valid permutation.** All 94 real cards appear exactly once in the shuffled deck. No duplicates, no missing cards, no extra cards beyond the 94 real + 34 padding leaves.
- **Commitment consistency.** The Merkle tree whose root is committed on-chain is built from the shuffled deck via Poseidon.
- **Canonical hash consistency.** The publicly-known canonical deck hashes to the same value regardless of permutation (canonical check).

**Does NOT prove:**

- **Randomness or unpredictability.** The dealer picks the permutation. The circuit does not know or care how. If the dealer stacks the deck (e.g., puts BUST cards on top for targeted players), the proof still verifies — it just asserts the permutation is a permutation.
- **Game-session binding.** The public inputs to the Groth16 proof are `(merkle_root, canonical_hash)`. They don't include `game_id`. A compromised or malicious dealer could theoretically re-use a shuffle (same proof) across multiple games where it can predict which game will call `commit_deck` next. Mitigation deferred to Pre-Mainnet 5.0.2 (add `game_id` as a public input + constraint in the circuit).
- **Dealer honesty over time.** If the dealer's random-generation seed leaks or is pre-committed, an attacker can predict every shuffle the dealer will produce. The current model trusts the dealer-operator to use a fresh `crypto.getRandomValues()` per round and not log the seed.

See [ZK Research](../reference/zk-research.md) for the full landscape survey (why Groth16 over Plonk, why Poseidon over SHA256, why arkworks vs snarkjs) and [Pre-Mainnet Checklist 5.0.2](https://github.com/Panmoni/pushflip/blob/main/docs/EXECUTION_PLAN.md) for the threshold-randomness plan.

## The `vault_ready` runtime check

A subtle but load-bearing design choice worth understanding.

- `initialize` records a `vault_pda` address in the GameSession account but **does not create an SPL token account** there. Only the program can sign for its own PDAs, so creating the token account requires a separate CPI.
- `init_vault` is the separate CPI — it creates the SPL token account at the vault PDA, owned by the vault PDA itself (so only the program can move tokens out). **Only the game authority can call `init_vault`** (heavy-duty review #5 H1).
- `init_vault` is **irreversible**. There is no `close_vault` instruction. Once a game is in real-stake mode, it stays in real-stake mode for its entire lifetime.
- Until `init_vault` runs, `vault.data_len() == 0`. `join_round` checks this at runtime and, if the vault token account is missing, **silently skips the SPL transfer** and records `staked_amount = 0` in the player's state. Everything else (turn order, round mechanics, end-round state mutations) still works — just with zero real tokens moving.

**Why this matters for security:**

- **Griefing resistance.** An attacker can't create a GameSession for themselves, tell a victim to `joinRound` against it (thereby transferring their $FLIP stake), and then never `end_round`. Until the authority calls `init_vault`, `joinRound` doesn't transfer tokens regardless of who calls it.
- **Authority consent is explicit.** A game only moves into "real money is at stake" mode when its authority deliberately broadcasts `init_vault`. The CLI helper in [`scripts/init-vault.ts`](https://github.com/Panmoni/pushflip/blob/main/scripts/init-vault.ts) prints an `IRREVERSIBLE` warning and requires the wallet to match the stored authority.
- **Frontend graceful degradation.** The app can read `GameSession.vault` and check whether the token account exists, then render "test mode" or "real stake" based on that runtime check — no separate state flag needed.

## Heavy-duty review catches

Fifteen heavy-duty reviews have shipped. Every one caught at least one structural bug the unit tests missed. The most instructive:

- **Review #5, Critical C1 — cross-game claim exploit.** A player participating in both game A and game B could pass game A's `player_state` along with game B's `game_session` + `bounty_board` and claim a game B bounty using their game A qualifications. Fix: `claim_bounty` now captures `gs.game_id()` from the `game_session` borrow block and cross-checks against `ps.game_id()`. See [`program/src/instructions/bounty/claim_bounty.rs`](https://github.com/Panmoni/pushflip/blob/main/program/src/instructions/bounty/claim_bounty.rs).
- **Review #5, Critical H1 — missing authority check on `init_vault`.** Any signer with ~0.002 SOL could call `init_vault` on any game and flip it into real-stake mode (irreversibly). Fix: authority signature + `gs.authority == payer.address()` gate.
- **Review #5, Medium M1 — mid-round bounty claims.** `claim_bounty` lacked a `round_active == false` check. The first player to call `stay()` could snipe a SURVIVOR bounty before other players acted. Fix: reject claims while `round_active == true`.
- **Task 3.2 — double-click double-spend pattern.** A user double-clicking the Join button sent two `joinRound` transactions. The first landed, the second failed (`PlayerAlreadyJoined`) but burned ~5000 lamports of tx fees. On-chain defense held; the UX fix was frontend optimistic state + button disable during pending.
- **Lesson #42 — the BigInt-u64 silent-wrap chain.** Four separate occurrences across two years of `BigInt(stringFromUserInput)` in the codebase — `BigInt("18446744073709551616")` wraps to 0 without error; `BigInt("-1")` is accepted as a negative bigint then silently wraps in `setBigUint64`; `BigInt("0xff")` is accepted as hex. Consolidated into `@pushflip/client::parseU64(raw, fieldName)` with strict `/^\d+$/` + `U64_MAX` bounds check. Pre-Mainnet 5.0.4 final state.
- **Lesson #40 — wallet `publicKey` object-identity footgun.** Three occurrences of listing `useWallet().publicKey` directly in a React hook dependency array. The web3.js-v1 `PublicKey` object's identity is not stable across renders, so hooks re-fire on every render. Fix: always derive `publicKeyBase58 = publicKey?.toBase58() ?? null` and depend on that. **Enforced by Biome GritQL plugin** at [`app/biome-plugins/no-publickey-in-hook-deps.grit`](https://github.com/Panmoni/pushflip/blob/main/app/biome-plugins/no-publickey-in-hook-deps.grit) — Pre-Mainnet 5.0.8 DONE.
- **Review #14 — the "plausible ghost" pattern (formally named in Lesson #50).** Pass 1 subagents have 5 times confidently flagged pre-existing correct behavior as a regression (reviews #9, #10, #13, #14, #15). The Pass 2 discipline of cross-referencing every finding against downstream consumers (grep/tsc/actual callers) has caught every one. Mechanism, not prose, is what maintains the security review's signal-to-noise ratio.

For the complete list see [docs/EXECUTION_PLAN.md](https://github.com/Panmoni/pushflip/blob/main/docs/EXECUTION_PLAN.md) → "Lessons Learned" (51 lessons as of 2026-04-15).

## Mitigations status

| Concern | Status | Notes |
|---|---|---|
| Cross-game `player_state` reuse | ✅ Fixed | Review #5 C1 fix landed. Cross-game check via `game_id` on `player_state` + `game_session` enforced in `claim_bounty`. |
| Authority gating on `init_vault` | ✅ Fixed | Review #5 H1 fix. Only game authority can flip to real-stake. |
| Mid-round bounty claim race | ✅ Fixed | Review #5 M1. `round_active == false` required. |
| Cross-reference error variant drift | ✅ Fixed | Review #5 M3. Standardized `InvalidPda` across bounty instructions. |
| BigInt-u64 silent wrap | ✅ Fixed | Pre-Mainnet 5.0.4. `parseU64` helper + 9 unit tests. Biome lint rule for `BigInt(userInput)` deferred. |
| Wallet `publicKey` in hook deps | ✅ Fixed | Pre-Mainnet 5.0.8. Biome GritQL plugin blocks it at lint time. Known blindspot: `[publicKey.toBase58()]` (new string every render) — documented in the plugin header + backstopped by pre-PR grep. |
| Cross-game Groth16 proof reuse | ⏳ Deferred | Pre-Mainnet 5.0.2. Requires circuit rework to add `game_id` as a public input. |
| Single-trusted-dealer | ⏳ Deferred | Pre-Mainnet 5.0.2. Threshold randomness / multi-party dealer protocol. Multi-week scope. |
| Oversized program data slot | ⏳ Deferred | Pre-Mainnet 5.0.1. Purely space efficiency, no security impact. |
| Final full-scope security review | ⏳ Planned | Pre-Mainnet 5.0.3. Gate before any mainnet deploy. Will cover everything on this page plus fresh eyes. |
| Event-feed authenticity | ✅ Shipped | Pre-Mainnet 5.0.9 PR 1. Frontend no longer reconstructs events from client-side diffs; on-chain `pinocchio_log` events are the single source of truth. PR 2 (frontend consumer rewrite) pending 24h bake. |
| Token promotion to permanent mint | ⏳ Deferred | Pre-Mainnet 5.0.6. `$FLIP` with metadata + multisig authority. |

## Out of scope

The program does not and cannot defend against:

- **User wallet compromise.** If an attacker has the user's seed phrase, they have the user's $FLIP and SOL. Standard Solana wallet model.
- **RPC MITM.** A compromised RPC endpoint could serve stale or malicious state. Users are responsible for pointing their wallet at a trusted RPC. The frontend defends by re-running `simulateTransaction` before the wallet sees a tx (review #12 fix, Lesson #46), but a truly malicious RPC can still misreport confirmation.
- **Social engineering of the deployer.** If the authority keypair leaks, the attacker can do everything the authority can do. Mitigation: authority multisig for mainnet (Pre-Mainnet 5.0.6).
- **Browser extension / wallet-adapter attacks.** A malicious wallet extension can sign anything the user clicks "approve" on. Users are responsible for installing only trusted extensions.
- **Solana runtime / validator bugs.** If the BPF loader or a syscall like `sol_poseidon` has a bug, the program inherits it. Mitigation: none at the application layer; rely on Anza + the validator ecosystem.
- **Denial-of-service at the RPC or validator layer.** Spam, prioritization fees, congestion. Users on mainnet will pay for priority; the program has no control.
- **Regulatory risk.** Not a security concern for this page, but worth noting. Operating a real-money card game with a House that wins over time has compliance implications in most jurisdictions. Out of scope for this document.

## Today, also read

- [README → Known Limitations](https://github.com/Panmoni/pushflip/blob/main/README.md) — the user-facing summary version of this page
- [FAQ → Probing/Critical Q9–Q17](../reference/faq.md) — question-shaped deep-dives on many of the trust assumptions
- [ZK Research](../reference/zk-research.md) — the ZK landscape and rationale
- [docs/EXECUTION_PLAN.md → Pre-Mainnet Checklist](https://github.com/Panmoni/pushflip/blob/main/docs/EXECUTION_PLAN.md) — the gated-on-mainnet work list
- [docs/EXECUTION_PLAN.md → Lessons Learned](https://github.com/Panmoni/pushflip/blob/main/docs/EXECUTION_PLAN.md) — the full 51-entry history of bugs caught, patterns named, and mechanisms added
