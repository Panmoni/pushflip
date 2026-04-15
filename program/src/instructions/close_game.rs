use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use crate::{
    errors::PushFlipError,
    state::game_session::{GameSession, GAME_SESSION_DISCRIMINATOR},
    utils::accounts::{verify_account_owner, verify_signer, verify_writable},
    ID,
};

/// Process the CloseGame instruction.
///
/// Closes the game session and returns rent to the authority.
/// Can only be called when round is not active and pot is 0.
///
/// Accounts:
///   0. `[writable]` game_session
///   1. `[signer]`   authority — must match game_session.authority
///   2. `[writable]` recipient — receives the rent lamports (usually authority)
pub fn process(accounts: &[AccountView], _data: &[u8]) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let [game_session, authority, recipient] = &accounts[..3] else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let owner = pinocchio::Address::new_from_array(ID);
    verify_account_owner(game_session, &owner)?;
    verify_writable(game_session)?;
    verify_signer(authority)?;
    verify_writable(recipient)?;

    let logged_game_id;
    {
        let gs_data = game_session.try_borrow_mut()?;
        let gs = GameSession::from_bytes(&gs_data);

        if gs.discriminator() != GAME_SESSION_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        if gs.authority() != authority.address().as_array() {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if gs.round_active() {
            return Err(PushFlipError::RoundAlreadyActive.into());
        }
        if gs.pot_amount() != 0 {
            return Err(PushFlipError::PotNotEmpty.into());
        }

        logged_game_id = gs.game_id();
    }

    // Close the account: transfer lamports to recipient, then close
    let game_lamports = game_session.lamports();
    let recipient_lamports = recipient.lamports();
    game_session.set_lamports(0);
    recipient.set_lamports(recipient_lamports.saturating_add(game_lamports));
    game_session.close()?;

    pinocchio_log::log!("pushflip:close_game:game_id={}", logged_game_id);

    Ok(())
}
