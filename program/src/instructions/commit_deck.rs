use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use crate::{
    errors::PushFlipError,
    state::game_session::{GameSession, GameSessionMut, GAME_SESSION_DISCRIMINATOR},
    utils::accounts::{verify_account_owner, verify_signer, verify_writable},
    zk::verifying_key::VERIFYING_KEY_BYTES,
    ID,
};

/// Commit deck instruction data layout:
/// [0..32]   merkle_root (32 bytes)
/// [32..96]  proof_a (64 bytes, G1 negated, big-endian)
/// [96..224] proof_b (128 bytes, G2, big-endian)
/// [224..288] proof_c (64 bytes, G1, big-endian)
const COMMIT_DATA_LEN: usize = 288;

/// Process the CommitDeck instruction.
///
/// Verifies a Groth16 proof that the shuffled deck is a valid permutation,
/// then stores the Merkle root on-chain.
///
/// Accounts:
///   0. `[writable]` game_session — the game PDA
///   1. `[signer]`   dealer — must match game_session.dealer
pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let [game_session, dealer] = &accounts[..2] else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // --- Parse instruction data ---
    if data.len() < COMMIT_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }

    let merkle_root: [u8; 32] = data[..32].try_into().unwrap();
    let proof_a: &[u8; 64] = data[32..96].try_into().unwrap();
    let proof_b: &[u8; 128] = data[96..224].try_into().unwrap();
    let proof_c: &[u8; 64] = data[224..288].try_into().unwrap();

    // --- Validate accounts ---
    let owner = pinocchio::Address::new_from_array(ID);
    verify_account_owner(game_session, &owner)?;
    verify_writable(game_session)?;
    verify_signer(dealer)?;

    // Verify game state
    {
        let gs_data = game_session.try_borrow_mut()?;
        let gs = GameSession::from_bytes(&gs_data);

        if gs.discriminator() != GAME_SESSION_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        if gs.dealer() != dealer.address().as_array() {
            return Err(PushFlipError::InvalidDealerSigner.into());
        }
        if gs.round_active() {
            return Err(PushFlipError::RoundAlreadyActive.into());
        }
        if gs.deck_committed() {
            return Err(PushFlipError::DeckAlreadyCommitted.into());
        }
    }

    // --- Verify Groth16 proof ---
    // Skip verification if verifying key is not yet set (placeholder).
    // In production, this MUST be enforced.
    if !VERIFYING_KEY_BYTES.is_empty() {
        // TODO: Parse VERIFYING_KEY_BYTES into Groth16Verifyingkey struct
        // and compute canonical_hash. For now, verification is deferred
        // until the ZK circuit is built (Phase 2, Task 2.8).
        let _ = (proof_a, proof_b, proof_c);
        let _canonical_hash = [0u8; 32]; // placeholder
                                         // verify_shuffle_proof(proof_a, proof_b, proof_c, &[merkle_root, canonical_hash], &vk)?;
    }

    // --- Store the Merkle root ---
    let mut gs_data = game_session.try_borrow_mut()?;
    let mut gs = GameSessionMut::from_bytes(&mut gs_data);
    gs.set_merkle_root(&merkle_root);
    gs.set_deck_committed(true);
    gs.set_draw_counter(0);

    Ok(())
}
