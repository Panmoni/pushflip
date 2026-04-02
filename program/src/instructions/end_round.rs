use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use crate::{
    errors::PushFlipError,
    state::{
        game_session::{GameSession, GameSessionMut, GAME_SESSION_DISCRIMINATOR},
        player_state::{PlayerState, PLAYER_STATE_DISCRIMINATOR, STAYED},
    },
    utils::accounts::{verify_account_owner, verify_signer, verify_writable},
    ID,
};

/// Process the EndRound instruction.
///
/// Determines the winner and resets round state.
/// Token distribution will be added in Phase 2.
///
/// Accounts:
///   0. `[writable]` game_session
///   1. `[signer]`   caller — must be authority, dealer, or a player in turn_order
///   2..N `[]`       player_states — must match turn_order in order
pub fn process(accounts: &[AccountView], _data: &[u8]) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let game_session = &accounts[0];
    let caller = &accounts[1];
    let player_accounts = &accounts[2..];

    let owner = pinocchio::Address::new_from_array(ID);
    verify_account_owner(game_session, &owner)?;
    verify_writable(game_session)?;
    verify_signer(caller)?;

    let player_count;
    {
        let gs_data = game_session.try_borrow_mut()?;
        let gs = GameSession::from_bytes(&gs_data);

        if gs.discriminator() != GAME_SESSION_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        if !gs.round_active() {
            return Err(PushFlipError::RoundNotActive.into());
        }

        player_count = gs.player_count() as usize;
        if player_accounts.len() < player_count {
            return Err(ProgramError::NotEnoughAccountKeys);
        }

        // Verify caller is authority, dealer, or a player in turn_order
        let caller_addr = caller.address().as_array();
        let is_authorized = caller_addr == gs.authority()
            || caller_addr == gs.dealer()
            || (0..player_count).any(|i| gs.turn_order_slot(i) == caller_addr);

        if !is_authorized {
            return Err(ProgramError::MissingRequiredSignature);
        }

        // Verify each player_state account matches the corresponding turn_order slot
        for i in 0..player_count {
            if player_accounts[i].address().as_array() != gs.turn_order_slot(i) {
                return Err(PushFlipError::PlayerStateMismatch.into());
            }
        }
    }

    // --- Check all players are inactive, find winner ---
    let mut highest_score: u64 = 0;
    let mut all_busted = true;

    for i in 0..player_count {
        let ps_account = &player_accounts[i];
        verify_account_owner(ps_account, &owner)?;

        let ps_data = ps_account.try_borrow_mut()?;
        if ps_data.len() < 110 || ps_data[0] != PLAYER_STATE_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }

        let ps = PlayerState::from_bytes(&ps_data);
        if ps.is_active() {
            return Err(PushFlipError::PlayersStillActive.into());
        }

        if ps.inactive_reason() == STAYED {
            all_busted = false;
            let score = ps.score();
            if score > highest_score {
                highest_score = score;
            }
        }
    }

    // --- Update GameSession ---
    {
        let mut gs_data = game_session.try_borrow_mut()?;
        let mut gs = GameSessionMut::from_bytes(&mut gs_data);

        if all_busted {
            let rollover = gs.as_ref().rollover_count();
            if rollover >= 10 {
                // Cap reached: stakes must be returned proportionally.
                // Phase 2 will add token CPI here. For now, reset accounting
                // so the game doesn't deadlock. The pot is NOT silently lost —
                // tokens remain in the vault until Phase 2 distribution is added.
                gs.set_rollover_count(0);
                // NOTE: pot_amount is NOT zeroed here. It stays in the vault.
                // Phase 2 must implement proportional return before clearing.
            } else {
                gs.set_rollover_count(rollover.saturating_add(1));
            }
        } else {
            gs.set_rollover_count(0);
            // Phase 2: distribute pot to winner via token CPI
        }

        gs.set_round_active(false);
        gs.set_deck_committed(false);
        gs.set_draw_counter(0);
    }

    Ok(())
}
