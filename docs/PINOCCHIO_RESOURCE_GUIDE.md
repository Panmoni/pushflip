# Pinocchio Development Resource Guide for PushFlip

Comprehensive documentation, tutorials, and resources for building the PushFlip on-chain
gambling program using Pinocchio (the zero-dependency Solana framework by Anza).

---

## Table of Contents

1. [Official Documentation and Core References](#1-official-documentation-and-core-references)
2. [Tutorials and Step-by-Step Guides](#2-tutorials-and-step-by-step-guides)
3. [Example Programs and Repositories](#3-example-programs-and-repositories)
4. [IDL Generation (Shank + Codama)](#4-idl-generation-shank--codama)
5. [PDAs and CPIs in Pinocchio](#5-pdas-and-cpis-in-pinocchio)
6. [Account Borrow Semantics & Gotchas](#6-account-borrow-semantics--gotchas)
7. [Testing with LiteSVM](#7-testing-with-litesvm)
8. [Pinocchio vs Anchor Comparison](#8-pinocchio-vs-anchor-comparison)
9. [Project Templates and Starters](#9-project-templates-and-starters)
10. [Recommended Toolchain for PushFlip](#10-recommended-toolchain-for-pushflip)
11. [Poseidon hashing via `sol_poseidon` syscall](#11-poseidon-hashing-via-sol_poseidon-syscall)

---

## 1. Official Documentation and Core References

### Pinocchio GitHub Repository (Official)
- **URL**: https://github.com/anza-xyz/pinocchio
- **Quality**: Authoritative. Maintained by Anza (Solana's Agave client developers). Actively updated through 2026.
- **What it covers**: Core library, API types, feature flags, entrypoint patterns, zero-copy design.
- **Key takeaways**:
  - Latest version: **0.11.x**
  - Entrypoint macro: `program_entrypoint!` (eager) or `lazy_program_entrypoint!` (lazy/on-demand parsing)
  - Also requires: `default_allocator!` and `default_panic_handler!` (or `no_allocator!()` for zero-alloc programs)
  - Handler signature: `fn handler(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult`
  - Feature flags:
    - `alloc` (default) -- enables `Vec`/`String` support
    - `cpi` -- cross-program invocation helpers + instruction/signer types
    - `copy` -- derives `Copy` on types
    - `account-resize` -- runtime account data resizing
  - Lazy entrypoint provides `remaining()`, `next_account()`, `instruction_data()`, `program_id()` for on-demand parsing
  - Use `default-features = false` to disable heap allocation entirely

### Pinocchio API Docs (docs.rs)
- **URL**: https://docs.rs/pinocchio/latest/pinocchio/
- **Quality**: Auto-generated from source. Canonical reference for all types and methods.
- **Key takeaways**: Reference for `AccountView`, `ProgramResult`, `Seed`, `Signer`, CPI invoke helpers.

### Pinocchio Companion Crates
- `pinocchio-system` -- System program CPI helpers (Transfer, CreateAccount, etc.)
- `pinocchio-token` -- SPL Token program CPI helpers
- `pinocchio-log` -- Lightweight logging (`log!` macro)
- `pinocchio-pubkey` -- `declare_id!` macro for program ID

---

## 2. Tutorials and Step-by-Step Guides

### QuickNode: Build and Deploy a Solana Program Using Pinocchio (BEST OVERALL TUTORIAL)
- **URL**: https://www.quicknode.com/guides/solana-development/pinocchio/how-to-build-and-deploy-a-solana-program-using-pinocchio
- **Quality**: Excellent. Most comprehensive end-to-end tutorial available. Covers the FULL workflow from program to client to tests.
- **What it covers**: Vault program with deposit/withdraw, Shank IDL generation, Codama client generation, TypeScript testing with Solana Kit.
- **Key takeaways**:
  - Complete Cargo.toml with `pinocchio`, `pinocchio-system`, `pinocchio-log`, `pinocchio-pubkey`, `shank`
  - Program structure: `lib.rs` (entrypoint + dispatcher) + `instructions.rs` (handlers)
  - Instruction dispatching via `match instruction_data.split_first()` with single-byte discriminators
  - Account validation via `TryFrom` trait implementations
  - PDA derivation with `find_program_address`
  - CPI using `pinocchio_system::instructions::Transfer` and `CreateAccount`
  - IDL generation: `shank idl -o idl`
  - Client generation: `npx codama init && npx codama run js`
  - Testing against `solana-test-validator` with Solana Kit (`@solana/kit`)

### Helius: How to Build Solana Programs with Pinocchio
- **URL**: https://www.helius.dev/blog/pinocchio
- **Quality**: Good conceptual overview with code examples. Less hands-on than QuickNode guide.
- **What it covers**: Framework comparison, Token2022 creation example, zero-copy concepts, tooling ecosystem.
- **Key takeaways**:
  - Pinocchio is "unopinionated" -- no enforced project structure
  - Must use external tools (Shank/Codama) for IDL
  - Bytemuck recommended over Borsh for account serialization
  - Performance: 88-95% CU reduction vs solana-program in token operations

### Pinocchio Guide (Community Tutorial)
- **URL**: https://github.com/vict0rcarvalh0/pinocchio-guide
- **Tutorial**: https://github.com/vict0rcarvalh0/pinocchio-guide/blob/main/TUTORIAL.md
- **Quality**: Good. Shows Anchor-to-Pinocchio migration side-by-side.
- **What it covers**: Converting an Anchor Vault to Pinocchio, account validation patterns, CPI patterns.
- **Key takeaways**:
  - Side-by-side Anchor vs Pinocchio code comparison
  - How to replace `#[derive(Accounts)]` with manual `TryFrom` implementations
  - PDA seed construction patterns

### Blueshift: Pinocchio for Dummies (Course)
- **URL**: https://learn.blueshift.gg/en/courses/pinocchio-for-dummies/pinocchio-101
- **Quality**: Good structured course. 9 lessons covering fundamentals to advanced topics.
- **What it covers**: Accounts, instructions, errors, data operations, testing (Mollusk), performance, middleware entrypoint, batch instructions.
- **Key takeaways**:
  - TryFrom trait is the core pattern for account validation
  - Single-byte discriminators support up to 255 instructions
  - Mollusk framework for unit testing (alternative to LiteSVM)
  - Middleware entrypoint pattern for hot-path optimization
  - Batch instructions to reduce CPI overhead

### Accelerate 2025 Talk: No Strings Attached Programs with Pinocchio
- **URL**: https://solanacompass.com/learn/accelerate-25/scale-or-die-2025-no-strings-attached-programs-w-pinocchio
- **Quality**: Excellent. Direct from Pinocchio's creator (Fernando Otero / Febo at Anza).
- **Key takeaways**:
  - "Program first" design: no deps, zero alloc, zero-copy
  - P-Token (SPL reimplementation): 88-95% CU reduction, 40% smaller binary
  - CPI operations: 5x CU reduction
  - Logging: up to 10x improvement
  - Lazy entrypoint delays input reading for single-instruction programs
  - Safe code is possible -- unsafe variants exist for extra optimization
  - Future: integration into Solana SDK, Token22 + ATA optimizations

---

## 3. Example Programs and Repositories

### Awesome Pinocchio (Curated List)
- **URL**: https://github.com/deltartificial/awesome-pinocchio
- **Quality**: Excellent curated list. The best starting point for finding examples.
- **Key projects listed**:

| Project | URL | Relevance to PushFlip |
|---------|-----|----------------------|
| P-Token (SPL Token reimplementation) | https://github.com/solana-program/token/tree/main/p-token | Token operations reference |
| Pinocchio Staking | https://github.com/Turbin3/pinocchio-stake | Staking/locking patterns |
| Pinocchio Escrow (ASCorreia) | https://github.com/ASCorreia/pinocchio-escrow | Multi-party fund management |
| Pinocchio Escrow (PaulX) | https://github.com/ogunbor/pinocchio-escrow-paulx | Classic escrow pattern |
| Pinocchio Bonding Curve | https://github.com/harsh4786/bonding-curve-pinocchio | Token economics |
| Native Flash Loan | https://github.com/L0STE/native-flash-loan-program | Advanced CPI patterns |
| Raydium CPMM CPI | https://github.com/kirarisk/pinocchio-raydium-cpmm-cpi | DEX integration CPI |
| SPL Examples | https://github.com/L0STE/pinocchio-spl-examples | Token mint/transfer patterns |
| Pinocchio Vault | https://github.com/stellarnodeN/Pinocchio-Vault | PDA + deposit/withdraw |
| Solana Pinocchio Starter | https://github.com/Nagaprasadvr/solana-pinocchio-starter | Boilerplate template |
| Pinocchio CLI Init | https://github.com/bidhan-a/pinocchio-init | Project scaffolding tool |

### Anchor + Pinocchio Side-by-Side
- **URL**: https://github.com/bluntbrain/solana-projects
- **Quality**: Good for comparison. Has both Anchor and Pinocchio implementations.

---

## 4. IDL Generation (Shank + Codama)

### The Workflow

```
Pinocchio Program (Rust)
    |
    | (annotate with Shank macros)
    v
shank idl -o idl/        --> generates IDL JSON
    |
    | (feed to Codama)
    v
codama run js             --> TypeScript client
codama run rust           --> Rust client
```

### Shank (IDL Generation from Native Programs)
- **URL**: https://github.com/metaplex-foundation/shank
- **Install**: `cargo install shank-cli`
- **Quality**: Mature tool from Metaplex. Has preliminary Pinocchio support (PR #69).
- **How it works**:
  - Add `shank` to your Cargo.toml dependencies
  - Annotate an instruction enum with `#[derive(ShankInstruction)]`
  - Use `#[account(...)]` attributes to define account metadata per instruction
  - Run `shank idl -o idl/` to generate the IDL JSON

**Example Shank annotation:**
```rust
#[derive(ShankInstruction)]
pub enum GameInstruction {
    #[account(0, signer, writable, name = "player", desc = "The player")]
    #[account(1, writable, name = "game_state", desc = "Game PDA")]
    #[account(2, name = "system_program", desc = "System Program")]
    StartGame { bet_amount: u64 },

    #[account(0, signer, name = "player", desc = "The player")]
    #[account(1, writable, name = "game_state", desc = "Game PDA")]
    Hit {},

    #[account(0, signer, name = "player", desc = "The player")]
    #[account(1, writable, name = "game_state", desc = "Game PDA")]
    #[account(2, writable, name = "vault", desc = "House vault PDA")]
    Stay {},
}
```

### Codama (Client Generation)
- **URL**: https://github.com/codama-idl/codama
- **Docs**: https://solana.com/docs/programs/codama/clients
- **Install**: `npm install codama`
- **Quality**: Actively maintained. Official Solana Foundation recommended tool for 2026.
- **Available renderers**:
  - `@codama/renderers-js` -- JavaScript/TypeScript (Solana Kit compatible)
  - `@codama/renderers-rust` -- Rust (Solana SDK compatible)
  - `@codama/renderers-go` -- Go
  - `@limechain/codama-dart` -- Dart
  - `codama-py` -- Python
- **Commands**:
  - `codama init` -- creates `codama.json` config pointing to your IDL
  - `codama run js` -- generate TypeScript client
  - `codama run rust` -- generate Rust client
  - `codama run --all` -- run all configured renderers

### Solana IDL Guide (Official)
- **URL**: https://solana.com/developers/guides/advanced/idls
- **Quality**: Official. Covers all approaches (Anchor, Shank, Codama, manual).

---

## 5. PDAs and CPIs in Pinocchio

### PDA Derivation

```rust
use pinocchio::pubkey::find_program_address;

// Derive a game state PDA
let (game_pda, bump) = find_program_address(
    &[b"game", player.key().as_ref()],
    &crate::ID,
);

// Verify the passed account matches
if account.key() != &game_pda {
    return Err(ProgramError::InvalidAccountData);
}
```

### CPI with PDA Signing (invoke_signed)

```rust
use pinocchio::instruction::{Seed, Signer};
use pinocchio_system::instructions::CreateAccount;

// Build signer seeds for PDA
let signer_seeds = [
    Seed::from(b"vault".as_slice()),
    Seed::from(owner.key().as_ref()),
    Seed::from(core::slice::from_ref(&bump)),
];
let signer = Signer::from(&signer_seeds);

// CPI: Create account owned by our program
CreateAccount {
    from: payer,
    to: vault_account,
    lamports: rent_lamports,
    space: ACCOUNT_SIZE as u64,
    owner: &crate::ID,
}
.invoke_signed(&[signer])?;
```

### CPI: Transfer SOL

```rust
use pinocchio_system::instructions::Transfer as SystemTransfer;

// Simple transfer (signer is in accounts list)
SystemTransfer {
    from: player,
    to: vault,
    lamports: bet_amount,
}
.invoke()?;
```

### CPI: Transfer from PDA (signed)

```rust
// Transfer FROM a PDA (requires invoke_signed)
SystemTransfer {
    from: vault,
    to: winner,
    lamports: payout,
}
.invoke_signed(&[vault_signer])?;
```

### Direct Lamport Manipulation (No CPI Needed)

For program-owned accounts, you can directly modify lamports without CPI:

```rust
// Withdraw from a program-owned account (no system program CPI needed)
{
    let mut vault_lamports = vault.try_borrow_mut_lamports()?;
    *vault_lamports = vault_lamports
        .checked_sub(amount)
        .ok_or(ProgramError::InsufficientFunds)?;
}
{
    let mut recipient_lamports = recipient.try_borrow_mut_lamports()?;
    *recipient_lamports = recipient_lamports
        .checked_add(amount)
        .ok_or(ProgramError::InsufficientFunds)?;
}
```

---

## 6. Account Borrow Semantics & Gotchas

### `try_borrow_mut()` does NOT enforce `is_writable`

This is a non-obvious Pinocchio (and `solana-account-view`) behavior that bit us during a code review. **The runtime check for whether an account is writable is enforced post-execution, not at borrow time.** Specifically:

| Layer | What it checks |
|-------|---------------|
| `AccountView::try_borrow_mut()` | Only checks the **borrow state** (whether the account is currently being borrowed by another in-program borrow). Does NOT check `AccountMeta.is_writable`. |
| `AccountView::is_writable()` | Returns the flag, but you have to call it explicitly. |
| `verify_writable(account)` | Wraps the explicit check above and returns an error. **You must call this yourself if you want runtime enforcement.** |
| **Solana validator** | Compares each account's data + lamports before/after the program executes. If an account marked READONLY in the AccountMeta was actually modified, the entire transaction is reverted. |

**The important consequence:** A program can call `try_borrow_mut()` on an account that the AccountMeta declared `READONLY`, the call will succeed, and the transaction will succeed too — *as long as the program never actually writes to the data*. The `try_borrow_mut()` succeeds because it only checks the in-program borrow state. The runtime allows the transaction to commit because no actual modification occurred.

### Why this matters

This affects three things:

1. **Source of truth for client developers.** The `///   0. [writable]` docstring on the instruction is the closest thing to a spec. If the program borrows mut but never writes, the docstring should still say `[]` so clients pass the account as `READONLY`. This enables parallel reads in transactions and reduces the lock contention surface.

2. **Code review can be misled.** Reviewers (or AI agents) reading the function body will see `try_borrow_mut()` and assume the account must be writable. They might flag a TS client passing `READONLY` as a critical bug. **It is not** — the transaction will work fine. But it IS a footgun because:

3. **Future-proofing.** If you call `try_borrow_mut()` today with no actual writes, that works. But if a future contributor adds a `gs.set_*()` call inside that block without realizing the AccountMeta says `READONLY`, the runtime will silently revert the modification (or fail the transaction, depending on Solana version) — and the bug will only show up on devnet/mainnet, never in unit tests.

### Best practice: match the borrow type to the actual usage

**Always use `try_borrow()` when you only read.** `try_borrow_mut()` should be reserved for code paths that actually write to the data:

```rust
// BAD: borrows mut but only reads — misleading + footgun
let gs_data = game_session.try_borrow_mut()?;
let gs = GameSession::from_bytes(&gs_data);
if !gs.round_active() {
    return Err(PushFlipError::RoundNotActive.into());
}

// GOOD: borrow type matches usage
let gs_data = game_session.try_borrow()?;
let gs = GameSession::from_bytes(&gs_data);
if !gs.round_active() {
    return Err(PushFlipError::RoundNotActive.into());
}
```

This makes the intent obvious to reviewers and aligns with the AccountMeta marking. If the docstring says `[]`, the code should `try_borrow()`. If the docstring says `[writable]`, the code can `try_borrow_mut()` AND should actually write to it (otherwise demote the docstring).

### Use `verify_writable()` when you DO need to enforce it

If your function genuinely requires the account to be writable (e.g. you're going to mutate state and expect those mutations to persist), call `verify_writable()` explicitly:

```rust
verify_writable(player_state)?;  // Fails fast if AccountMeta says READONLY
let mut ps_data = player_state.try_borrow_mut()?;
let mut ps = PlayerStateMut::from_bytes(&mut ps_data);
ps.set_score(new_score);  // Will actually persist
```

Without the `verify_writable()` check, a misconfigured client could pass `READONLY` and the program would silently lose the write.

### Empirical evidence from PushFlip

This guidance comes from a real-world test in the PushFlip codebase. In Phase 2, the `burn_second_chance` instruction was discovered to have:

- Docstring: `[writable] game_session`
- Code: `try_borrow_mut()` followed by reads only (no writes)
- Integration test: `AccountMeta::new(...)` (writable)
- TS client: `AccountRole.READONLY`

After fixing both burn instructions to use `try_borrow()`, updating the docstring to `[]`, and changing all 4 integration test sites to `AccountMeta::new_readonly(...)`, **all 4 burn_second_chance integration tests still passed**. This empirically confirms that the runtime allows `READONLY` accounts to be borrowed mut as long as no actual write occurs.

See: [program/src/instructions/burn_second_chance.rs](../program/src/instructions/burn_second_chance.rs), [program/src/instructions/burn_scry.rs](../program/src/instructions/burn_scry.rs), [tests/src/phase2.rs](../tests/src/phase2.rs) test_burn_second_chance_*.

### Related: `verify_account_owner()` is also separate

Same pattern applies to ownership: `try_borrow_mut()` does not check that the account is owned by your program. You must call `verify_account_owner(account, &expected_owner)?` explicitly. Forgetting this is a classic Solana vulnerability — a malicious user could pass an account they own (with attacker-chosen data) and the program would deserialize it as if it were one of yours.

**Always verify ownership before deserializing program state.** The discriminator check helps but is not sufficient — an attacker can craft an account with the right discriminator byte.

---

## 7. Testing with LiteSVM

### Overview
- **URL**: https://github.com/LiteSVM/litesvm
- **Guide**: https://www.quicknode.com/guides/solana-development/tooling/litesvm
- **API Docs**: https://docs.rs/litesvm/latest/litesvm/
- **Quality**: Recommended by Solana Foundation for 2026. Fast, in-process VM testing.

### Setup

```toml
# Cargo.toml
[dev-dependencies]
litesvm = "0.8"
litesvm-token = "0.8"   # optional: SPL token test helpers
```

### Core API

```rust
use litesvm::LiteSVM;

// Initialize
let mut svm = LiteSVM::new();

// Load your compiled program
let program_id = Pubkey::from_str("YOUR_PROGRAM_ID").unwrap();
let program_bytes = std::fs::read("target/deploy/pushflip.so").unwrap();
svm.add_program(program_id, &program_bytes);

// Fund accounts
svm.airdrop(&player_pubkey, 1_000_000_000).unwrap();

// Set arbitrary account state
svm.set_account(pda_key, Account {
    lamports: 100_000_000,
    data: vec![0u8; 128],
    owner: program_id,
    executable: false,
    rent_epoch: 0,
});

// Send transactions
let tx = Transaction::new(
    &[&keypair],
    Message::new(&[instruction], Some(&payer)),
    svm.latest_blockhash(),
);
let result = svm.send_transaction(tx);
assert!(result.is_ok());

// Read account state after transaction
let account = svm.get_account(&pda_key).expect("account exists");
```

### Time Travel (Clock Manipulation)

```rust
// Advance the clock (useful for time-locked game rounds)
let mut clock: Clock = svm.get_sysvar::<Clock>();
clock.unix_timestamp += 3600;  // advance 1 hour
svm.set_sysvar::<Clock>(&clock);

// Jump to future slot
svm.warp_to_slot(500);

// Expire blockhash (test expiry paths)
svm.expire_blockhash();
```

### Testing Tiers (Solana Foundation Recommendation)

| Level | Tool | Purpose |
|-------|------|---------|
| Unit tests | **Mollusk** | Isolated single-instruction testing |
| Integration tests | **LiteSVM** | Full program interaction, multi-instruction flows |
| E2E tests | **Surfpool** | Mainnet-like conditions, fork testing |

### Alternative: Mollusk (Lighter Weight Unit Tests)
- **URL**: https://github.com/buffalojoec/mollusk
- Focused on single-instruction unit testing
- Even lighter than LiteSVM for simple validation tests

---

## 8. Pinocchio vs Anchor Comparison

### Performance Benchmarks

| Metric | Anchor | Pinocchio | Improvement |
|--------|--------|-----------|-------------|
| Simple instruction CU | ~649 CU | ~109 CU | **~6x reduction** |
| SPL Token operations | Baseline | 88-95% less CU | **~10-20x reduction** |
| CPI overhead | Baseline | 5x less CU | **5x reduction** |
| Binary size | Baseline | ~40% smaller | **40% reduction** |
| Log formatting | Baseline | ~10x less CU | **10x reduction** |

### Feature Comparison

| Feature | Anchor | Pinocchio |
|---------|--------|-----------|
| Account validation | Automatic (macros) | Manual (TryFrom trait) |
| IDL generation | Built-in | External (Shank + Codama) |
| Serialization | Borsh (copies data) | Zero-copy (direct access) |
| Dependencies | Many (solana-program, etc.) | Zero external deps |
| Learning curve | Lower | Higher |
| Program structure | Opinionated | Unopinionated |
| Error handling | Built-in error types | Manual custom errors |
| Client generation | anchor-client | Codama renderers |
| Testing | anchor-bankrun, anchor-litesvm | LiteSVM, Mollusk |
| `#![no_std]` support | No | Yes |
| Allocator control | No | Yes (`no_allocator!()`) |

### When to Choose Pinocchio (PushFlip Should)

- Performance-critical on-chain logic (gambling requires minimal CU for profitability)
- Portfolio differentiation (shows deeper Solana understanding than Anchor)
- Full control over account validation (important for security in gambling dApps)
- Smaller binary size (lower deploy cost)
- Future-proof: Anchor v2 is likely to use Pinocchio as its entrypoint

### Migration Path from Anchor Thinking

1. Replace `#[derive(Accounts)]` with manual `TryFrom<&[AccountInfo]>` implementations
2. Replace `#[program]` module with `entrypoint!` macro + match dispatcher
3. Replace Borsh serialization with direct byte slice access or bytemuck
4. Replace `ctx.accounts.field` with indexed array access `accounts[0]`
5. Replace `anchor_lang::system_program::transfer` with `pinocchio_system::instructions::Transfer`
6. Replace built-in IDL with Shank annotations + Codama generation

---

## 9. Project Templates and Starters

### Official Pinocchio Counter Template (RECOMMENDED STARTING POINT)
- **URL**: https://solana.com/developers/templates/pinocchio-counter
- **Source**: https://github.com/solana-foundation/templates/tree/main/pinocchio/pinocchio-counter
- **Quality**: Official Solana Foundation template. Production-grade structure.
- **Structure**:
  ```
  program/src/
    instructions/     -- create_counter/, increment/
    state/            -- account state definitions
    traits/           -- AccountSerialize, AccountDeserialize, PdaSeeds
    events/           -- event emission via CPI
    utils/            -- validation utilities
  clients/
    typescript/       -- Codama-generated TS client
    rust/             -- Codama-generated Rust client
  tests/
    integration-tests/  -- LiteSVM integration tests
  scripts/            -- Codama generation scripts
  justfile            -- Build commands
  ```
- **Build commands**:
  - `just build` -- build program + generate clients
  - `just generate-idl` -- generate IDL from Rust code
  - `just generate-clients` -- regenerate clients from IDL
  - `just integration-test` -- run LiteSVM tests

### Solana Pinocchio Starter
- **URL**: https://github.com/Nagaprasadvr/solana-pinocchio-starter
- **Quality**: Community maintained. Good minimal boilerplate.

### Pinocchio CLI Init
- **URL**: https://github.com/bidhan-a/pinocchio-init
- **Quality**: Scaffolding tool for new projects.

### Exo-Tech Template
- **URL**: https://github.com/exo-tech-xyz/pinocchio-project
- **Quality**: Community template with good defaults.

---

## 10. Recommended Toolchain for PushFlip

Based on all research, here is the recommended stack for the PushFlip gambling dApp:

### On-Chain Program
| Component | Tool | Why |
|-----------|------|-----|
| Framework | **Pinocchio 0.11** | Zero-dep, minimal CU, portfolio differentiator |
| System CPI | **pinocchio-system** | Transfer, CreateAccount helpers |
| Token CPI | **pinocchio-token** | SPL token operations for game tokens |
| Logging | **pinocchio-log** | Lightweight on-chain logging |
| Program ID | **pinocchio-pubkey** | `declare_id!` macro |
| IDL annotations | **Shank** | `#[derive(ShankInstruction)]` for IDL generation |

### Client + IDL
| Component | Tool | Why |
|-----------|------|-----|
| IDL generation | **Shank CLI** | `shank idl -o idl/` |
| Client generation | **Codama** | `codama run js` for TypeScript, `codama run rust` for Rust |
| TypeScript SDK | **@solana/kit v5** | Official 2026 recommended client library |
| Wallet adapter | **Solana Foundation framework-kit** | React hooks for wallet connection |

### Testing
| Component | Tool | Why |
|-----------|------|-----|
| Unit tests | **Mollusk** | Fast single-instruction validation |
| Integration tests | **LiteSVM 0.8** | Full program flow, clock manipulation, 25x faster than TS |
| E2E tests | **Surfpool** | Mainnet fork testing for final validation |

### Build + Deploy
| Component | Tool | Why |
|-----------|------|-----|
| Build | `cargo build-sbf` | Standard Solana BPF compilation |
| Deploy | `solana program deploy` | Direct deployment |
| Task runner | **just** (justfile) | Used by official templates |

### Project Structure (Recommended)

```
pushflip/
  program/
    Cargo.toml
    src/
      lib.rs                    -- entrypoint + instruction dispatcher
      instructions/
        mod.rs
        start_game.rs           -- initialize game PDA, accept bet
        hit.rs                  -- draw card, update state
        stay.rs                 -- resolve round, calculate score
        settle.rs               -- payout or collect from vault
      state/
        mod.rs
        game.rs                 -- GameState account definition
        vault.rs                -- House vault PDA
      errors.rs                 -- Custom ProgramError variants
      utils.rs                  -- Validation helpers, randomness
  idl/                          -- Generated by Shank
  clients/
    typescript/                 -- Generated by Codama
    rust/                       -- Generated by Codama
  tests/
    integration/                -- LiteSVM tests
  scripts/
    generate-idl.sh
    generate-clients.sh
  justfile
```

### Minimal Cargo.toml

```toml
[package]
name = "pushflip"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["lib", "cdylib"]

[dependencies]
pinocchio = { version = "0.11", default-features = false }
pinocchio-system = "0.5"
pinocchio-token = "0.4"
pinocchio-log = "0.4"
pinocchio-pubkey = "0.3"
shank = "0.4"

[dev-dependencies]
litesvm = "0.8"
```

---

## 11. Poseidon hashing via `sol_poseidon` syscall

If your Pinocchio program needs Poseidon (e.g. ZK-SNARK Merkle proofs over
BN254), **do not pull in `light_poseidon` directly.** The crate's BN254-X5
parameter constructor (`light_poseidon::parameters::bn254_x5::get_poseidon_parameters`)
allocates roughly 200 BN254 field elements as stack locals, producing an
~11 KB stack frame that exceeds Solana's 4 KB BPF stack limit.

The symptom is sneaky:

- `cargo build-sbf` prints `Error: Function _ZN14light_poseidon... Stack offset of 10960 exceeded max offset of 4096 by 6864 bytes` but **still produces a binary** (the linker keeps going).
- LiteSVM tests pass — LiteSVM does not enforce the 4 KB stack frame check the way the real validator does.
- The first call into `light_poseidon::Poseidon::new_circom` on a real validator aborts with `Access violation in stack frame 5 at address 0x200005010 of size 8` after consuming ~200K CU.

### Use the native syscall instead

The Solana validator exposes Poseidon via the `sol_poseidon` syscall, with
ABI:

```rust
extern "C" {
    fn sol_poseidon(
        parameters: u64,      // 0 = BN254-X5
        endianness: u64,      // 0 = big-endian
        vals: *const u8,      // pointer to a contiguous array of slice fat pointers
        val_len: u64,         // number of inputs (≤ 12)
        hash_result: *mut u8, // output buffer (32 bytes)
    ) -> u64;                 // 0 on success
}
```

Pinocchio 0.10.2 doesn't re-export this syscall — declare it directly in
your crate. The signature is in
[`solana-define-syscall::definitions`](https://docs.rs/solana-define-syscall/)
and is stable across Solana versions.

### Byte compatibility with `light_poseidon` (and circomlibjs)

`solana-poseidon` v3.1's non-Solana fallback path literally delegates to:

```rust
light_poseidon::Poseidon::<ark_bn254::Fr>::new_circom(N).hash_bytes_be(_)
```

so the syscall and `light_poseidon` produce identical bytes for the BN254-X5
circom variant. circomlibjs uses the same parameter set, so all three
implementations agree. **You do not need to recompute on-chain Merkle roots
or canonical hashes when migrating.**

### Reference implementation

PushFlip's wrapper is at
[`program/src/zk/poseidon_native.rs`](../program/src/zk/poseidon_native.rs).
It exposes `hash_card_leaf` and `hash_pair` helpers, dispatches to the
syscall on the SBF target, and falls back to `light_poseidon` on the host so
unit tests can still cross-validate. The corresponding `Cargo.toml` pattern
keeps `light_poseidon` out of the deployed binary entirely:

```toml
[dependencies]
# (no light-poseidon here)

[target.'cfg(not(target_os = "solana"))'.dependencies]
light-poseidon = "0.4"
ark-bn254 = "0.5"
```

### Performance impact

Migrating PushFlip's `hit` instruction from in-program `light_poseidon` to
`sol_poseidon` dropped its compute consumption from **211 142 CU**
(mid-flight crash) to **7 771 CU** (clean success) — a ~27× reduction. The
savings come from offloading parameter construction to validator-internal
optimized code instead of charging the program for ~200 BN254 field-element
allocations on every call.

---

## Sources

- [Pinocchio GitHub (Official)](https://github.com/anza-xyz/pinocchio)
- [QuickNode: Build and Deploy with Pinocchio](https://www.quicknode.com/guides/solana-development/pinocchio/how-to-build-and-deploy-a-solana-program-using-pinocchio)
- [Helius: How to Build Solana Programs with Pinocchio](https://www.helius.dev/blog/pinocchio)
- [Pinocchio Counter Template](https://solana.com/developers/templates/pinocchio-counter)
- [Pinocchio Guide (Community)](https://github.com/vict0rcarvalh0/pinocchio-guide)
- [Blueshift: Pinocchio for Dummies Course](https://learn.blueshift.gg/en/courses/pinocchio-for-dummies/pinocchio-101)
- [Awesome Pinocchio](https://github.com/deltartificial/awesome-pinocchio)
- [P-Token (SPL Token Reimplementation)](https://github.com/febo/p-token)
- [Pinocchio Vault Example](https://github.com/stellarnodeN/Pinocchio-Vault)
- [Codama (Client Generation)](https://github.com/codama-idl/codama)
- [Codama Client Docs](https://solana.com/docs/programs/codama/clients)
- [Shank (IDL Generation)](https://github.com/metaplex-foundation/shank)
- [Solana IDL Guide](https://solana.com/developers/guides/advanced/idls)
- [LiteSVM](https://github.com/LiteSVM/litesvm)
- [QuickNode: Test with LiteSVM](https://www.quicknode.com/guides/solana-development/tooling/litesvm)
- [LiteSVM API Docs](https://docs.rs/litesvm/latest/litesvm/)
- [Accelerate 2025: Pinocchio Talk](https://solanacompass.com/learn/accelerate-25/scale-or-die-2025-no-strings-attached-programs-w-pinocchio)
- [Solana Dev Skill (2026 Best Practices)](https://github.com/solana-foundation/solana-dev-skill)
- [Solana Foundation Templates](https://github.com/solana-foundation/templates)
- [Pinocchio Bonding Curve](https://github.com/harsh4786/bonding-curve-pinocchio)
- [Pinocchio Escrow](https://github.com/ASCorreia/pinocchio-escrow)
- [Pinocchio Staking](https://github.com/Turbin3/pinocchio-stake)
- [Raydium CPMM CPI](https://github.com/kirarisk/pinocchio-raydium-cpmm-cpi)
- [Native Flash Loan](https://github.com/L0STE/native-flash-loan-program)
- [Pinocchio SPL Examples](https://github.com/L0STE/pinocchio-spl-examples)
- [Solana Optimized Programs](https://github.com/Laugharne/solana_optimized_programs)
- [Anchor vs Pinocchio Projects](https://github.com/bluntbrain/solana-projects)
- [Shank Pinocchio Support PR](https://github.com/metaplex-foundation/shank/pull/69)
- [Solana Pinocchio Starter](https://github.com/Nagaprasadvr/solana-pinocchio-starter)
- [Pinocchio CLI Init](https://github.com/bidhan-a/pinocchio-init)
