/// Groth16 verifying key for the shuffle verification circuit.
///
/// Generated during trusted setup (Phase 2, Task 2.8).
/// Replace with real key after circuit compilation with:
///   snarkjs zkey export verificationkey circuit.zkey vk.json
///   then convert to Rust bytes with the groth16-solana JS helper.
///
/// The verifying key is specific to the circuit — if the circuit
/// changes, a new trusted setup and key are required.
///
/// Format: pinocchio-groth16 Groth16Verifyingkey fields serialized as bytes.
/// Fields: nr_pubinputs, vk_alpha_g1 (64), vk_beta_g2 (128),
///         vk_gamma_g2 (128), vk_delta_g2 (128), vk_ic (N × 64)
///
/// Placeholder: empty slice. Will fail at verification until replaced.
pub const VERIFYING_KEY_BYTES: &[u8] = &[];
