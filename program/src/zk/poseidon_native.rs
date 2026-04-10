//! Poseidon BN254 X5 hashing for Pinocchio programs.
//!
//! This module exists to avoid `light_poseidon::parameters::bn254_x5::get_poseidon_parameters`,
//! whose ~11 KB stack frame exceeds the BPF 4 KB stack limit and causes the
//! validator to abort with `Access violation in stack frame 5` on the first
//! real call (see [docs/POSEIDON_STACK_WARNING.md](../../../docs/POSEIDON_STACK_WARNING.md)).
//!
//! On the Solana SBF target we call the validator's native `sol_poseidon`
//! syscall directly. The syscall implementation lives in the validator and
//! consumes ~0 BPF stack from our perspective.
//!
//! On the host target (`cargo test` on x86_64) we fall back to `light_poseidon`
//! so unit tests still cross-validate against the same Rust crate the dealer
//! and the canonical-deck-hash JS code use.
//!
//! ## Byte compatibility with `light_poseidon`
//!
//! `solana-poseidon` v3.1's non-Solana fallback (in
//! `~/.cargo/registry/.../solana-poseidon-3.1.11/src/lib.rs`) literally
//! delegates to:
//!
//! ```ignore
//! light_poseidon::Poseidon::<ark_bn254::Fr>::new_circom(N).hash_bytes_be(_)
//! ```
//!
//! which is exactly the call our previous `merkle.rs` made. Therefore the
//! syscall produces byte-identical output to our previous implementation,
//! and `CANONICAL_DECK_HASH` does not need to be regenerated. The
//! `test_canonical_deck_hash_matches_js` host unit test guards this
//! invariant.

#[cfg(target_os = "solana")]
mod sys {
    /// Poseidon parameter set: BN254 curve, x5 S-box (the only set the
    /// validator currently supports). Matches
    /// `solana_poseidon::Parameters::Bn254X5 = 0`.
    pub const PARAMETERS_BN254_X5: u64 = 0;

    /// Big-endian inputs and result. Matches
    /// `solana_poseidon::Endianness::BigEndian = 0` and
    /// `light_poseidon::PoseidonBytesHasher::hash_bytes_be`.
    pub const ENDIANNESS_BIG_ENDIAN: u64 = 0;

    // Direct extern declaration of the Solana validator's `sol_poseidon`
    // syscall. The signature is taken verbatim from
    // `solana-define-syscall-5.0.0/src/definitions.rs:5`:
    //
    //     fn sol_poseidon(
    //         parameters: u64,
    //         endianness: u64,
    //         vals: *const u8,
    //         val_len: u64,
    //         hash_result: *mut u8,
    //     ) -> u64
    //
    // `vals` points at a contiguous array of `val_len` slice fat pointers
    // (each is `(ptr: u64, len: u64)`), which the validator decodes via
    // `translate_slice_of_slices`. Returns 0 on success.
    extern "C" {
        pub fn sol_poseidon(
            parameters: u64,
            endianness: u64,
            vals: *const u8,
            val_len: u64,
            hash_result: *mut u8,
        ) -> u64;
    }
}

/// Compute `Poseidon(BN254-X5, BigEndian, inputs)`.
///
/// Each input must be exactly 32 bytes and a valid BN254 field element
/// (i.e. less than the field modulus). All callers in this crate construct
/// inputs by zero-padding small `u8` values into a 32-byte buffer, which is
/// always a valid field element.
///
/// Panics if the syscall returns nonzero. The default Pinocchio panic
/// handler turns this into a clean program abort. With our inputs this is
/// unreachable in practice — it would only fire if a future caller passed
/// >12 inputs, non-32-byte slices, or values exceeding the BN254 modulus.
#[cfg(target_os = "solana")]
fn hashv(inputs: &[&[u8]]) -> [u8; 32] {
    let mut out = [0u8; 32];
    // SAFETY: This relies on three properties of the SBF target's ABI,
    // each verified against Solana validator source:
    //
    //   1. `&[&[u8]]` is laid out as a contiguous array of slice fat
    //      pointers `(ptr: u64, len: u64)`. The validator decodes the
    //      `vals_addr`/`vals_len` arguments via
    //      `translate_slice_of_slices` (see solana-bpf-loader-program-
    //      2.2.20/src/syscalls/mod.rs, the `SyscallPoseidon::rust` impl),
    //      which is the inverse of this layout. The SBF target uses the
    //      same Rust slice representation as every other target, so this
    //      cast is well-defined.
    //
    //   2. `inputs.len()` fits in a `u64`. On the SBF target, `usize` is
    //      already `u64`, so this is a no-op widening.
    //
    //   3. `out.as_mut_ptr()` points at exactly 32 writable bytes. The
    //      validator writes `HASH_BYTES = 32` bytes via
    //      `translate_slice_mut::<u8>(memory_mapping, result_addr, 32, …)`,
    //      so the buffer length matches.
    //
    // The official `solana-poseidon-3.1.11` crate performs the identical
    // cast in its `hashv()` implementation (see lib.rs:280:
    // `vals as *const _ as *const u8`), so this matches the canonical
    // reference.
    let result = unsafe {
        sys::sol_poseidon(
            sys::PARAMETERS_BN254_X5,
            sys::ENDIANNESS_BIG_ENDIAN,
            inputs.as_ptr() as *const u8,
            inputs.len() as u64,
            out.as_mut_ptr(),
        )
    };
    assert!(result == 0, "sol_poseidon syscall returned nonzero");
    out
}

#[cfg(not(target_os = "solana"))]
fn hashv(inputs: &[&[u8]]) -> [u8; 32] {
    use light_poseidon::{Poseidon, PoseidonBytesHasher};
    let mut hasher = Poseidon::<ark_bn254::Fr>::new_circom(inputs.len())
        .expect("light_poseidon: invalid circom width");
    hasher
        .hash_bytes_be(inputs)
        .expect("light_poseidon: hash_bytes_be failed")
}

/// Hash a card's fields into a Poseidon leaf:
/// `Poseidon(value, card_type, suit, leaf_index)`.
///
/// Each `u8` is right-padded into a 32-byte big-endian buffer before
/// hashing, matching the dealer's `circomlibjs` encoding so that the
/// on-chain Merkle proof verifier sees the same leaf bytes the dealer
/// committed to.
pub fn hash_card_leaf(value: u8, card_type: u8, suit: u8, leaf_index: u8) -> [u8; 32] {
    let mut input0 = [0u8; 32];
    let mut input1 = [0u8; 32];
    let mut input2 = [0u8; 32];
    let mut input3 = [0u8; 32];
    input0[31] = value;
    input1[31] = card_type;
    input2[31] = suit;
    input3[31] = leaf_index;
    hashv(&[&input0, &input1, &input2, &input3])
}

/// Poseidon hash of two 32-byte nodes (for Merkle internal nodes).
pub fn hash_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    hashv(&[left.as_ref(), right.as_ref()])
}

// NOTE: There are no unit tests in this file by design.
//
// On the host (`cargo test`), `hashv()` resolves to the `light_poseidon`
// fallback above — which is exactly what `crate::zk::merkle::tests`
// already covers (deterministic, change-on-input, canonical-deck-hash
// cross-validation against JS, full-depth Merkle proof verification).
// Adding host-side tests here would duplicate that coverage without
// exercising the actual `sol_poseidon` syscall path.
//
// The syscall path itself (the `#[cfg(target_os = "solana")]` branch of
// `hashv`) is exercised end-to-end by `scripts/smoke-test.ts`, which
// runs `hit` against a real validator and verifies a real Merkle proof
// constructed by the dealer's `circomlibjs` Poseidon. That's the only
// test environment where the syscall actually runs.
