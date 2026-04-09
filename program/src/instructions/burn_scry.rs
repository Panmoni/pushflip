use pinocchio::{error::ProgramError, AccountView, ProgramResult};
use pinocchio_token::instructions::Burn;

use crate::{
    errors::PushFlipError,
    state::{
        game_session::{GameSession, GAME_SESSION_DISCRIMINATOR, MAX_PLAYERS},
        player_state::{PlayerStateMut, PLAYER_STATE_DISCRIMINATOR},
    },
    utils::{
        accounts::{verify_account_owner, verify_signer, verify_writable},
        constants::SCRY_COST,
    },
    ID,
};

/// Process the BurnScry instruction.
///
/// Player burns $FLIP tokens to peek at the next card. The on-chain program
/// burns tokens and emits an event; the off-chain dealer responds with the
/// card data (without committing it as drawn).
///
/// Accounts:
///   0. `[]`         game_session
///   1. `[writable]` player_state
///   2. `[signer]`   player
///   3. `[writable]` player_token_account — player's $FLIP ATA
///   4. `[writable]` token_mint — $FLIP mint (for burn)
///   5. `[]`         token_program
pub fn process(accounts: &[AccountView], _data: &[u8]) -> ProgramResult {
    if accounts.len() < 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let [game_session, player_state, player, player_token_account, token_mint, token_program] =
        &accounts[..6]
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // --- Validate accounts ---
    let owner = pinocchio::Address::new_from_array(ID);
    verify_account_owner(game_session, &owner)?;
    verify_account_owner(player_state, &owner)?;
    verify_writable(player_state)?;
    verify_signer(player)?;
    verify_writable(player_token_account)?;
    verify_writable(token_mint)?;

    if token_program.address() != &pinocchio_token::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Verify game is active and it's this player's turn
    {
        let gs_data = game_session.try_borrow()?;
        let gs = GameSession::from_bytes(&gs_data);
        if gs.discriminator() != GAME_SESSION_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        if !gs.round_active() {
            return Err(PushFlipError::RoundNotActive.into());
        }

        let current_idx = gs.current_turn_index() as usize;
        let player_count = gs.player_count() as usize;
        if current_idx >= player_count || current_idx >= MAX_PLAYERS {
            return Err(PushFlipError::InvalidTurnIndex.into());
        }
        if gs.turn_order_slot(current_idx) != player.address().as_array() {
            return Err(PushFlipError::NotYourTurn.into());
        }
    }

    // Validate player state
    {
        let mut ps_data = player_state.try_borrow_mut()?;
        if ps_data[0] != PLAYER_STATE_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }

        let mut ps = PlayerStateMut::from_bytes(&mut ps_data);
        if ps.as_ref().player() != player.address().as_array() {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if !ps.as_ref().is_active() {
            return Err(PushFlipError::PlayerNotActive.into());
        }
        if ps.as_ref().has_used_scry() {
            return Err(PushFlipError::ScryAlreadyUsed.into());
        }

        // --- Burn tokens ---
        Burn {
            account: player_token_account,
            mint: token_mint,
            authority: player,
            amount: SCRY_COST,
        }
        .invoke()?;

        // Mark scry as used (draw_counter is NOT incremented — peek only)
        ps.set_has_used_scry(true);
    }

    // Event emission would go here (off-chain dealer watches for this)
    // The dealer responds with the next card data without committing

    Ok(())
}
