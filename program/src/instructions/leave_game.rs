use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use crate::{
    errors::PushFlipError,
    state::{
        game_session::{GameSession, GameSessionMut, GAME_SESSION_DISCRIMINATOR},
        player_state::{PlayerStateMut, BUST, PLAYER_STATE_DISCRIMINATOR},
    },
    utils::accounts::{verify_account_owner, verify_signer, verify_writable},
    ID,
};

/// Process the LeaveGame instruction.
///
/// Player leaves the game. Behavior depends on round state:
/// - Round NOT active: remove from turn_order, close PlayerState, refund rent
/// - Round IS active: forfeit (score = 0, inactive, marked as bust)
///
/// Accounts:
///   0. `[writable]` game_session
///   1. `[writable]` player_state
///   2. `[signer]`   player
///   3. `[writable]` recipient — receives rent lamports (usually player)
pub fn process(accounts: &[AccountView], _data: &[u8]) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let [game_session, player_state, player, recipient] = &accounts[..4] else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let owner = pinocchio::Address::new_from_array(ID);
    verify_account_owner(game_session, &owner)?;
    verify_writable(game_session)?;
    verify_account_owner(player_state, &owner)?;
    verify_writable(player_state)?;
    verify_signer(player)?;
    verify_writable(recipient)?;

    // Validate PlayerState belongs to this player
    {
        let ps_data = player_state.try_borrow_mut()?;
        if ps_data[0] != PLAYER_STATE_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        let ps = crate::state::player_state::PlayerState::from_bytes(&ps_data);
        if ps.player() != player.address().as_array() {
            return Err(ProgramError::MissingRequiredSignature);
        }
    }

    let round_active;
    let player_count;
    {
        let gs_data = game_session.try_borrow_mut()?;
        let gs = GameSession::from_bytes(&gs_data);

        if gs.discriminator() != GAME_SESSION_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }

        round_active = gs.round_active();
        player_count = gs.player_count() as usize;

        // Verify player is in the turn order
        let mut found = false;
        for i in 0..player_count {
            if gs.turn_order_slot(i) == player.address().as_array() {
                found = true;
                break;
            }
        }
        if !found {
            return Err(PushFlipError::InvalidInstruction.into());
        }
    }

    if round_active {
        // --- Mid-round forfeit ---
        let mut ps_data = player_state.try_borrow_mut()?;
        let mut ps = PlayerStateMut::from_bytes(&mut ps_data);
        ps.set_is_active(false);
        ps.set_inactive_reason(BUST);
        ps.set_score(0);
    } else {
        // --- Between-rounds leave ---
        // Remove player from turn order
        {
            let mut gs_data = game_session.try_borrow_mut()?;
            let mut gs = GameSessionMut::from_bytes(&mut gs_data);

            // Find the player's index and compact the array
            let mut player_idx = None;
            for i in 0..player_count {
                if gs.as_ref().turn_order_slot(i) == player.address().as_array() {
                    player_idx = Some(i);
                    break;
                }
            }

            if let Some(idx) = player_idx {
                // Shift remaining players down
                for i in idx..player_count - 1 {
                    let next = *gs.as_ref().turn_order_slot(i + 1);
                    gs.set_turn_order_slot(i, &next);
                }
                // Clear the last slot
                gs.set_turn_order_slot(player_count - 1, &[0u8; 32]);
                gs.set_player_count((player_count - 1) as u8);
            }
        }

        // Close PlayerState account — transfer rent to recipient
        let ps_lamports = player_state.lamports();
        let recipient_lamports = recipient.lamports();
        player_state.set_lamports(0);
        recipient.set_lamports(recipient_lamports.saturating_add(ps_lamports));
        player_state.close()?;
    }

    Ok(())
}
