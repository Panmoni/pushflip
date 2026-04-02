use pinocchio::error::ProgramError;
use pinocchio_groth16::groth16::{Groth16Verifier, Groth16Verifyingkey};

use crate::errors::PushFlipError;

/// Verify a Groth16 proof that a shuffled deck is a valid permutation
/// of the canonical deck.
///
/// # Arguments
/// * `proof_a` - G1 point (64 bytes, big-endian, already negated)
/// * `proof_b` - G2 point (128 bytes, big-endian)
/// * `proof_c` - G1 point (64 bytes, big-endian)
/// * `public_inputs` - [merkle_root, canonical_hash] as 32-byte BE field elements
/// * `verifying_key` - The circuit's verifying key
///
/// # CU Cost
/// ~200,000 compute units (uses Solana alt_bn128 syscalls).
pub fn verify_shuffle_proof(
    proof_a: &[u8; 64],
    proof_b: &[u8; 128],
    proof_c: &[u8; 64],
    public_inputs: &[[u8; 32]; 2],
    verifying_key: &Groth16Verifyingkey<'_>,
) -> Result<(), ProgramError> {
    let mut verifier =
        Groth16Verifier::<2>::new(proof_a, proof_b, proof_c, public_inputs, verifying_key)
            .map_err(|_| PushFlipError::InvalidGroth16Proof)?;

    verifier
        .verify()
        .map_err(|_| PushFlipError::InvalidGroth16Proof)?;

    Ok(())
}
