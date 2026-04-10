use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use crate::{
    errors::PushFlipError,
    state::game_session::{GameSession, GameSessionMut, GAME_SESSION_DISCRIMINATOR},
    utils::accounts::{verify_account_owner, verify_signer, verify_writable},
    zk::{
        groth16::verify_shuffle_proof,
        verifying_key::{CANONICAL_DECK_HASH, VERIFYING_KEY_BYTES},
    },
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
    //
    // SECURITY: This is the on-chain Groth16 verification gate. The
    // production binary (built without `--features skip-zk-verify`) has
    // `VERIFYING_KEY_BYTES = &[1]` (non-empty), so the verifier ALWAYS
    // runs and rejects invalid proofs.
    //
    // The test binary (built by `tests/build.rs` with `--features
    // skip-zk-verify`) has `VERIFYING_KEY_BYTES = &[]`, which short-
    // circuits the verifier. This is intentional and only safe because
    // the test binary lives at a *different* on-disk path
    // (`target/deploy-test/pushflip.so`) than the deploy binary
    // (`target/deploy/pushflip.so`) — they cannot clobber each other.
    //
    // If you ever see the runtime log line below in a transaction, the
    // wrong binary has been deployed and the program is accepting any
    // proof bytes. The fix is to rebuild without `--features
    // skip-zk-verify` and redeploy.
    if VERIFYING_KEY_BYTES.is_empty() {
        // This branch is only reachable in test builds. Log loudly so a
        // production validator running the wrong binary screams in every
        // transaction's logs.
        pinocchio_log::log!(
            "WARNING: skip-zk-verify is enabled. ANY proof bytes accepted. NOT SAFE FOR PRODUCTION."
        );
    } else {
        let vk = crate::zk::verifying_key::verifying_key();
        let public_inputs = [merkle_root, CANONICAL_DECK_HASH];
        verify_shuffle_proof(proof_a, proof_b, proof_c, &public_inputs, &vk)?;
    }

    // --- Store the Merkle root ---
    let mut gs_data = game_session.try_borrow_mut()?;
    let mut gs = GameSessionMut::from_bytes(&mut gs_data);
    gs.set_merkle_root(&merkle_root);
    gs.set_deck_committed(true);
    gs.set_draw_counter(0);

    Ok(())
}
