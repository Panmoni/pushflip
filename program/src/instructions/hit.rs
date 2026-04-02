use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use crate::{
    errors::PushFlipError,
    state::{
        card::Card,
        game_session::{GameSession, GameSessionMut, GAME_SESSION_DISCRIMINATOR, MAX_PLAYERS},
        player_state::{PlayerStateMut, BUST, PLAYER_STATE_DISCRIMINATOR},
    },
    utils::{
        accounts::{verify_account_owner, verify_signer, verify_writable},
        scoring::check_bust,
    },
    zk::merkle::{verify_merkle_proof, MERKLE_DEPTH, TOTAL_LEAVES},
    ID,
};

/// Hit instruction data layout:
/// [0]       card_value
/// [1]       card_type
/// [2]       card_suit
/// [3..227]  merkle_proof (7 × 32 = 224 bytes)
/// [227]     leaf_index
const HIT_DATA_LEN: usize = 228;

/// Process the Hit instruction.
///
/// Draws a card by verifying a Merkle proof, adds it to the player's hand,
/// and checks for bust.
///
/// Accounts:
///   0. `[writable]` game_session
///   1. `[writable]` player_state
///   2. `[signer]`   player
pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let [game_session, player_state, player] = &accounts[..3] else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // --- Parse instruction data ---
    if data.len() < HIT_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }

    let card_value = data[0];
    let card_type = data[1];
    let card_suit = data[2];

    let mut merkle_proof = [[0u8; 32]; MERKLE_DEPTH];
    for i in 0..MERKLE_DEPTH {
        let start = 3 + i * 32;
        merkle_proof[i].copy_from_slice(&data[start..start + 32]);
    }

    let leaf_index = data[227];

    // Validate leaf_index is within the Merkle tree bounds
    if leaf_index as usize >= TOTAL_LEAVES {
        return Err(PushFlipError::LeafIndexOutOfRange.into());
    }

    // --- Validate accounts ---
    let owner = pinocchio::Address::new_from_array(ID);
    verify_account_owner(game_session, &owner)?;
    verify_writable(game_session)?;
    verify_account_owner(player_state, &owner)?;
    verify_writable(player_state)?;
    verify_signer(player)?;

    // --- Validate game state ---
    let merkle_root;
    let draw_counter;
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

        // Validate current_turn_index before using as array index
        let current_idx = gs.current_turn_index() as usize;
        player_count = gs.player_count() as usize;
        if current_idx >= player_count || current_idx >= MAX_PLAYERS {
            return Err(PushFlipError::InvalidTurnIndex.into());
        }

        if gs.turn_order_slot(current_idx) != player.address().as_array() {
            return Err(PushFlipError::NotYourTurn.into());
        }

        merkle_root = *gs.merkle_root();
        draw_counter = gs.draw_counter();
    }

    // Verify sequential card draw
    if leaf_index != draw_counter {
        return Err(PushFlipError::InvalidCardIndex.into());
    }

    // --- Verify Merkle proof ---
    verify_merkle_proof(
        card_value,
        card_type,
        card_suit,
        leaf_index,
        &merkle_proof,
        &merkle_root,
    )?;

    // --- Add card to hand ---
    let card = Card::new(card_value, card_type, card_suit);
    let is_bust;
    let bust_value;
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

        ps.push_card(&card);

        // Check bust
        let hand_size = ps.as_ref().hand_size();
        let mut hand = [Card::new(0, 0, 0); 10];
        for i in 0..hand_size as usize {
            hand[i] = ps.as_ref().card_at(i);
        }

        bust_value = check_bust(&hand, hand_size);
        is_bust = bust_value.is_some();

        if is_bust {
            ps.set_is_active(false);
            ps.set_inactive_reason(BUST);
            ps.set_bust_card_value(bust_value.unwrap());
        }
    }

    // --- Update game state ---
    {
        let mut gs_data = game_session.try_borrow_mut()?;
        let mut gs = GameSessionMut::from_bytes(&mut gs_data);

        gs.set_draw_counter(draw_counter.saturating_add(1));

        if is_bust {
            advance_turn(&mut gs, player_count);
        }
    }

    Ok(())
}

/// Advance to the next player in turn order. Simply rotates the index —
/// inactive players will fail validation when they attempt to hit/stay,
/// and end_round should be called once all players are inactive.
/// This is intentional: the on-chain program doesn't have access to
/// PlayerState accounts here, so it can't skip inactive players.
fn advance_turn(gs: &mut GameSessionMut<'_>, player_count: usize) {
    if player_count == 0 {
        return;
    }
    let current = gs.as_ref().current_turn_index() as usize;
    let next = (current + 1) % player_count;
    gs.set_current_turn_index(next as u8);
}
