//! close_bounty_board — close the BountyBoard PDA and refund rent.
//!
//! Symmetric to `close_game`. Authority can close the bounty board at
//! any time (regardless of bounty state) — outstanding bounties are
//! discarded along with the account.
//!
//! Accounts:
//!   0. `[writable]` bounty_board
//!   1. `[signer]`   authority — must match game_session.authority
//!   2. `[]`         game_session — for authority check
//!   3. `[writable]` recipient — receives the rent lamports

use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use crate::{
    errors::PushFlipError,
    state::{
        bounty::{BountyBoard, BOUNTY_BOARD_DISCRIMINATOR},
        game_session::{GameSession, GAME_SESSION_DISCRIMINATOR},
    },
    utils::accounts::{verify_account_owner, verify_signer, verify_writable},
    ID,
};

pub fn process(accounts: &[AccountView], _data: &[u8]) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let [bounty_board, authority, game_session, recipient] = &accounts[..4] else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    verify_writable(bounty_board)?;
    verify_signer(authority)?;
    verify_writable(recipient)?;

    let owner = pinocchio::Address::new_from_array(ID);
    verify_account_owner(bounty_board, &owner)?;
    verify_account_owner(game_session, &owner)?;

    // --- Verify authority matches the game's authority ---
    {
        let gs_data = game_session.try_borrow()?;
        let gs = GameSession::from_bytes(&gs_data);
        if gs.discriminator() != GAME_SESSION_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        if gs.authority() != authority.address().as_array() {
            return Err(ProgramError::MissingRequiredSignature);
        }
    }

    // --- Verify the bounty_board belongs to this game_session ---
    {
        let bb_data = bounty_board.try_borrow()?;
        let bb = BountyBoard::from_bytes(&bb_data);
        if bb.discriminator() != BOUNTY_BOARD_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        if bb.game_session() != game_session.address().as_array() {
            // Heavy-duty review #5 fix M3: standardize the cross-reference
            // error variant — claim_bounty.rs uses InvalidPda for the same
            // check; close_bounty_board.rs was using the generic
            // InvalidAccountData. Pick the more specific name.
            return Err(PushFlipError::InvalidPda.into());
        }
    }

    // --- Close the account: transfer lamports to recipient, then close ---
    let bounty_lamports = bounty_board.lamports();
    let recipient_lamports = recipient.lamports();
    bounty_board.set_lamports(0);
    recipient.set_lamports(recipient_lamports.saturating_add(bounty_lamports));
    bounty_board.close()?;

    Ok(())
}
