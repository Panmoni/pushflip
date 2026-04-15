use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use crate::{
    errors::PushFlipError,
    state::{
        card::Card,
        game_session::{GameSession, GameSessionMut, GAME_SESSION_DISCRIMINATOR, MAX_PLAYERS},
        player_state::{PlayerStateMut, PLAYER_STATE_DISCRIMINATOR, STAYED},
    },
    utils::{
        accounts::{verify_account_owner, verify_signer, verify_writable},
        events::HexPubkey,
        scoring::calculate_hand_score,
    },
    ID,
};

/// Process the Stay instruction.
///
/// Player locks in their score and ends their turn.
///
/// Accounts:
///   0. `[writable]` game_session
///   1. `[writable]` player_state
///   2. `[signer]`   player
pub fn process(accounts: &[AccountView], _data: &[u8]) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let [game_session, player_state, player] = &accounts[..3] else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // --- Validate accounts ---
    let owner = pinocchio::Address::new_from_array(ID);
    verify_account_owner(game_session, &owner)?;
    verify_writable(game_session)?;
    verify_account_owner(player_state, &owner)?;
    verify_writable(player_state)?;
    verify_signer(player)?;

    // --- Validate game state ---
    {
        let gs_data = game_session.try_borrow_mut()?;
        let gs = GameSession::from_bytes(&gs_data);

        if gs.discriminator() != GAME_SESSION_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        if !gs.round_active() {
            return Err(PushFlipError::RoundNotActive.into());
        }

        // Validate current_turn_index before using as array index
        let current_idx = gs.current_turn_index() as usize;
        let player_count = gs.player_count() as usize;
        if current_idx >= player_count || current_idx >= MAX_PLAYERS {
            return Err(PushFlipError::InvalidTurnIndex.into());
        }

        if gs.turn_order_slot(current_idx) != player.address().as_array() {
            return Err(PushFlipError::NotYourTurn.into());
        }
    }

    // --- Calculate score and update PlayerState ---
    let logged_score;
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

        // Calculate score from hand
        let hand_size = ps.as_ref().hand_size();
        let mut hand = [Card::new(0, 0, 0); 10];
        for i in 0..hand_size as usize {
            hand[i] = ps.as_ref().card_at(i);
        }
        let score = calculate_hand_score(&hand, hand_size);

        ps.set_score(score);
        ps.set_is_active(false);
        ps.set_inactive_reason(STAYED);

        logged_score = score;
    }

    // --- Advance turn ---
    let logged_game_id;
    let logged_round;
    {
        let mut gs_data = game_session.try_borrow_mut()?;
        let mut gs = GameSessionMut::from_bytes(&mut gs_data);

        let player_count = gs.as_ref().player_count() as usize;
        let current = gs.as_ref().current_turn_index() as usize;
        let next = (current + 1) % player_count;
        gs.set_current_turn_index(next as u8);

        logged_game_id = gs.as_ref().game_id();
        logged_round = gs.as_ref().round_number();
    }

    pinocchio_log::log!(
        "pushflip:stay:player={}|game_id={}|round={}|score={}",
        HexPubkey(player.address().as_array()),
        logged_game_id,
        logged_round,
        logged_score
    );

    Ok(())
}
