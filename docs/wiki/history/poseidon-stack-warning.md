---
title: Poseidon Stack Warning
diataxis_type: explanation
last_compiled: 2026-04-11
---

# light_poseidon Stack Warning — RESOLVED via `sol_poseidon` syscall

## :white_check_mark: Status (2026-04-09): RESOLVED in Task 2.10

The 11 KB stack frame issue with `light_poseidon::parameters::bn254_x5::get_poseidon_parameters`
has been eliminated by replacing all on-chain `light_poseidon` calls with a thin
wrapper around Solana's native `sol_poseidon` syscall. See
[program/src/zk/poseidon_native.rs](https://github.com/Panmoni/pushflip/blob/main/program/src/zk/poseidon_native.rs).

### Verification (2026-04-09)

A second devnet smoke test against the upgraded program
(`HQLeAQc84WLz8buHM5JAJGBjNJjwc6Fpxts8jSMaW3px`, deploy signature
`498y12uvHEQuCd1G1DSkE4tjgAyEwyyYakbGXBsyfpeziShLxfDeaWnotnxaXo3Ee711s9z6iQzg11UQnMU2Zzej`)
ran the full pipeline cleanly:

| Instruction | Before fix | After fix |
|---|---|---|
| `initialize` | ✅ | ✅ |
| `join_round` × 2 | ✅ | ✅ |
| `commit_deck` (Groth16) | ✅ | ✅ |
| `start_round` | ✅ | ✅ |
| **`hit` (Poseidon Merkle)** | ❌ Access violation in stack frame 5 at 211 142 CU | ✅ Success at **7 771 CU** |

That's a **~27× compute reduction** for the `hit` instruction, in addition to
eliminating the stack overflow. The native syscall offloads parameter
construction to validator-internal optimized code that costs a flat fee per
input rather than charging the program for ~200 BN254 field-element
allocations.

Successful `hit` transaction:
[`sgnnwAM2NBMRyMFii6uhkk1bdwqBHm25QPndhZm27rcnVPaZHNSdturtuHHn6bzoc95PxD8zqJfrFGWBNbZyrg7`](https://explorer.solana.com/tx/sgnnwAM2NBMRyMFii6uhkk1bdwqBHm25QPndhZm27rcnVPaZHNSdturtuHHn6bzoc95PxD8zqJfrFGWBNbZyrg7?cluster=devnet)

### What changed

1. **New module** `program/src/zk/poseidon_native.rs` declares the
   `sol_poseidon` syscall via `extern "C"` (the signature is taken verbatim
   from `solana-define-syscall::definitions`) and exposes
   `hash_card_leaf` / `hash_pair` helpers. On the SBF target the helpers
   call the syscall directly; on the host target (`cargo test`) they fall
   back to `light_poseidon` so the cross-validation tests still work.
2. **`merkle.rs`** re-exports the helpers and no longer touches
   `light_poseidon` or `ark_bn254` at all.
3. **`program/Cargo.toml`** moves `light-poseidon` and `ark-bn254` to
   `[target.'cfg(not(target_os = "solana"))'.dependencies]`. The deployed
   binary now contains zero `light_poseidon` code, and `cargo build-sbf`
   no longer prints the "Stack offset of 10960 exceeded max offset of 4096"
   diagnostic.
4. The host `test_canonical_deck_hash_matches_js` cross-validation test
   continues to pass — confirming the wrapper produces byte-identical output
   to the previous implementation. The on-chain `hit` succeeded because the
   syscall produced the same Merkle root the dealer committed to in
   `commit_deck`. **`CANONICAL_DECK_HASH` did not change.**

### Why this works

`solana-poseidon-3.1.11/src/lib.rs:262-271` shows that `solana_poseidon::hashv()`'s
non-Solana fallback path literally delegates to:

```rust
light_poseidon::Poseidon::<ark_bn254::Fr>::new_circom(vals.len()).hash_bytes_be(vals)
```

— exactly the call our previous `merkle.rs` made. The on-Solana path goes
through `sol_poseidon` (the validator native implementation). Both paths are
guaranteed to produce identical bytes for the BN254 X5 circom variant; the
solana-poseidon crate is the single source of truth for this guarantee.

---

## The warning

Every time we run `cargo build-sbf`, the linker prints:

```
Error: Function _ZN14light_poseidon10parameters8bn254_x523get_poseidon_parameters17h5fe0a29b6eb1ba64E
Stack offset of 10960 exceeded max offset of 4096 by 6864 bytes,
please minimize large stack variables. Estimated function frame size: 11008 bytes.
Exceeding the maximum stack offset may cause undefined behavior during execution.
```

It's labeled "Error" but the build still finishes successfully and produces a valid `.so` binary that we have deployed to devnet.

## What it actually means

**The literal claim**: A specific function in the `light_poseidon` crate has a stack frame of ~11 KB, but Solana's BPF virtual machine has a hard **4 KB stack limit** per function call.

The function in question is:

```rust
light_poseidon::parameters::bn254_x5::get_poseidon_parameters
```

After demangling the `_ZN...` Rust symbol, this is the function that builds the Poseidon hash parameters for the BN254 curve at the x5 round constant size — basically a constructor that returns:

- ~200 round constants (each is a 32-byte BN254 field element)
- A 3×3 MDS matrix of field elements
- Various other config values

When the Rust compiler stack-allocates all of those local variables in one function, the frame balloons to ~11 KB.

## Why Solana has a 4 KB stack limit

Solana validators run programs in a tightly constrained BPF VM. The 4 KB cap exists so:

- **Predictable memory use** — validators reserve fixed memory per program invocation
- **Cheap context switching** — small stacks mean fast invokes/CPIs
- **Anti-DoS** — programs can't blow up validator memory by deeply nested recursion

Solana doesn't *enforce* this at compile time the way most platforms enforce stack limits — instead, the linker emits this diagnostic message to *warn you*, then the VM enforces it *at runtime* if the limit is actually crossed.

## Why our build doesn't actually fail

Two reasons:

### 1. The diagnostic is a warning, not a hard failure

Despite the "Error:" prefix, the Solana SBF linker prints this and keeps going. The line right after says `Finished release profile [optimized] target(s)`. It produces a valid `pushflip.so` you can deploy.

### 2. The runtime doesn't necessarily hit the 11 KB peak

The compiler's "11 KB" estimate is the maximum the function *might* use if every local variable is live simultaneously. In practice, the optimizer can:

- Reuse stack slots for variables with non-overlapping lifetimes
- Promote some locals to registers
- Inline the function and let the surrounding code use stack more efficiently

So the real runtime stack use during a single call may be well under 4 KB even though the worst-case static analysis says 11 KB.

## Empirical evidence (so far)

We have a strong but **incomplete** signal that the warning is harmless:

| Test environment | Result | What it proves |
|------------------|--------|----------------|
| Rust unit tests | 41 passing | The Poseidon path works on native x86_64 (not BPF) |
| LiteSVM integration tests | 20 passing | Simulated BPF execution doesn't hit the runtime stack check |
| Devnet binary upload | Successful | The binary loads — but doesn't prove `hit` actually runs |

**What we have NOT yet verified:** Calling `hit` (or `commit_deck` with a real proof) on the actual devnet program. That's the call path that exercises `light_poseidon::Poseidon::new_circom`, which internally invokes the function with the 11 KB stack frame.

A planned smoke test in Phase 3 will close this gap (see [EXECUTION_PLAN.md Task 3.0](https://github.com/Panmoni/pushflip/blob/main/docs/EXECUTION_PLAN.md#task-30)).

## If the runtime check does fire

Symptoms would be:

- Transaction fails on-chain with `Program failed: Stack offset exceeded`
- CU consumption shows the program halted partway through `hit`
- Local LiteSVM tests would still pass (they simulate, not validate)

In that case, we have three real fix options:

### Option 1: Make the parameters `static`

Submit a PR to `light_poseidon` to declare the round constants as `const` arrays in a separate `.rs` file, generated at build time, instead of constructing them in a function. This would put the data in the `.rodata` section instead of the stack and eliminate the warning.

**Tradeoff**: It's an upstream change. We don't own `light_poseidon`. Vendoring our own fork is more maintenance burden than the warning is worth — but it's the cleanest fix.

### Option 2: Switch to Solana's native Poseidon syscall

Solana 1.16+ ships a `sol_poseidon` syscall accessible via `solana_program::poseidon`. The validator implements Poseidon natively in optimized code and there's no stack issue at all.

**Tradeoff**: It requires importing `solana-program` (or a thin wrapper), which conflicts with our Pinocchio "zero-dependency" architectural choice. The whole point of Pinocchio is to *not* depend on `solana-program`. If we import it just for one syscall, we lose the architectural-purity argument.

There is no `pinocchio-poseidon` crate yet that wraps the syscall in a Pinocchio-friendly way. We could write one — and that would be a useful contribution to the Pinocchio ecosystem upstream.

### Option 3: Implement Poseidon ourselves

Write our own Poseidon implementation that's stack-friendly.

**Tradeoff**: Reimplementing cryptography is the canonical "do not roll your own" mistake. The risk of subtle bugs in our hash function vastly outweighs the warning. **Rejected**.

## Why we're shipping with the warning for now

1. **All available test signals are green** — 94 tests passing across unit, integration, dealer, and client.
2. **The "proper" fixes are non-trivial** — they require either upstream changes or architectural compromises.
3. **The smoke test cost is low** — once Phase 3 has a working `hit` flow, we can verify in 5 minutes whether the warning matters.
4. **If it does fire, Option 2 (write `pinocchio-poseidon`) is upstream-friendly** — it would be a small open-source contribution to the Pinocchio ecosystem and would actually demonstrate deeper Solana internals knowledge.

## TL;DR

| | |
|---|---|
| **What it is** | The build-time linker diagnostic IS a real runtime issue |
| **Cause** | `light_poseidon::parameters::bn254_x5::get_poseidon_parameters` constructs ~200 BN254 field elements as stack locals, exceeding Solana's 4 KB BPF stack limit |
| **Confirmed on real devnet?** | YES (2026-04-09) — `hit` instruction crashes with `Access violation in stack frame 5` after consuming 211K CU |
| **Why LiteSVM tests pass** | LiteSVM doesn't enforce the 4 KB stack limit the same way the real validator does |
| **What works** | initialize, join_round, commit_deck (Groth16!), start_round all work on real validator |
| **What's broken** | Anything that calls `light_poseidon::Poseidon::new_circom` — currently `hit` (verify_merkle_proof) and the canonical-hash recompute fallback |
| **Fix** | Write `pinocchio-poseidon` wrapper around `sol_poseidon` syscall (Option 2 below) |
