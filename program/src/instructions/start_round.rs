use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use crate::{
    errors::PushFlipError,
    state::{
        game_session::{GameSession, GameSessionMut, GAME_SESSION_DISCRIMINATOR},
        player_state::{PlayerStateMut, ACTIVE, PLAYER_STATE_DISCRIMINATOR},
    },
    utils::accounts::{verify_account_owner, verify_signer, verify_writable},
    ID,
};

/// Process the StartRound instruction.
///
/// Begins a new round. Deck must be committed, at least 2 players required.
///
/// Accounts:
///   0. `[writable]`         game_session
///   1. `[signer]`           authority
///   2..N `[writable]`       player_states — must match turn_order in order
pub fn process(accounts: &[AccountView], _data: &[u8]) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let game_session = &accounts[0];
    let authority = &accounts[1];
    let player_accounts = &accounts[2..];

    // --- Validate ---
    let owner = pinocchio::Address::new_from_array(ID);
    verify_account_owner(game_session, &owner)?;
    verify_writable(game_session)?;
    verify_signer(authority)?;

    let player_count;
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
        if !gs.deck_committed() {
            return Err(PushFlipError::DeckNotCommitted.into());
        }

        player_count = gs.player_count() as usize;
        if player_count < 2 {
            return Err(PushFlipError::InvalidInstruction.into());
        }

        if player_accounts.len() < player_count {
            return Err(ProgramError::NotEnoughAccountKeys);
        }

        // Verify each player_state's stored player key matches the turn_order slot.
        // turn_order stores wallet addresses; PlayerState stores the same in its `player` field.
        for i in 0..player_count {
            let ps_data = player_accounts[i].try_borrow_mut()?;
            if ps_data.len() < 34 || ps_data[0] != PLAYER_STATE_DISCRIMINATOR {
                return Err(ProgramError::InvalidAccountData);
            }
            let stored_player: &[u8] = &ps_data[2..34]; // PLAYER field offset
            if stored_player != gs.turn_order_slot(i) {
                return Err(PushFlipError::PlayerStateMismatch.into());
            }
        }
    }

    // --- Reset all PlayerStates ---
    for i in 0..player_count {
        let ps_account = &player_accounts[i];
        verify_account_owner(ps_account, &owner)?;
        verify_writable(ps_account)?;

        let mut ps_data = ps_account.try_borrow_mut()?;
        if ps_data.len() < 110 || ps_data[0] != PLAYER_STATE_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }

        let mut ps = PlayerStateMut::from_bytes(&mut ps_data);
        ps.set_hand_size(0);
        ps.set_is_active(true);
        ps.set_inactive_reason(ACTIVE);
        ps.set_bust_card_value(0);
        ps.set_score(0);
        ps.set_has_used_second_chance(false);
        ps.set_has_used_scry(false);
    }

    // --- Update GameSession ---
    {
        let mut gs_data = game_session.try_borrow_mut()?;
        let mut gs = GameSessionMut::from_bytes(&mut gs_data);

        gs.set_round_active(true);
        gs.set_current_turn_index(0);
        let round = gs.as_ref().round_number();
        gs.set_round_number(round.saturating_add(1));
    }

    Ok(())
}
