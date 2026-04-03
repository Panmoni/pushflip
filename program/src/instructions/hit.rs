use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use crate::{
    errors::PushFlipError,
    state::{
        card::{Card, ALPHA, PROTOCOL, RUG_PULL, VAMPIRE_ATTACK},
        game_session::{GameSession, GameSessionMut, GAME_SESSION_DISCRIMINATOR, MAX_PLAYERS},
        player_state::{PlayerState, PlayerStateMut, BUST, PLAYER_STATE_DISCRIMINATOR},
    },
    utils::deck::DECK_SIZE,
    utils::{
        accounts::{verify_account_owner, verify_signer, verify_writable},
        scoring::check_bust,
    },
    zk::merkle::{verify_merkle_proof, MERKLE_DEPTH},
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
/// checks for bust, and applies protocol card effects.
///
/// Accounts:
///   0. `[writable]` game_session
///   1. `[writable]` player_state
///   2. `[signer]`   player
///   3..N (optional)  remaining accounts for protocol effects:
///     - For RUG_PULL/VAMPIRE_ATTACK: [target_player_state, ...]
///     - For AIRDROP: effect is skipped on-chain (off-chain bonus)
pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let game_session = &accounts[0];
    let player_state = &accounts[1];
    let player = &accounts[2];
    let remaining_accounts = &accounts[3..];

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

    // Reject padding leaves (94-127) — only real cards (0-93) are drawable
    if leaf_index as usize >= DECK_SIZE {
        return Err(PushFlipError::LeafIndexOutOfRange.into());
    }

    let owner = pinocchio::Address::new_from_array(ID);
    verify_account_owner(game_session, &owner)?;
    verify_writable(game_session)?;
    verify_account_owner(player_state, &owner)?;
    verify_writable(player_state)?;
    verify_signer(player)?;

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

    if leaf_index != draw_counter {
        return Err(PushFlipError::InvalidCardIndex.into());
    }

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
    let player_address;
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

        player_address = *ps.as_ref().player();
        ps.push_card(&card);

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
    // player_state borrow is dropped here

    // --- Apply protocol card effects (only if not busted) ---
    if !is_bust && card_type == PROTOCOL {
        apply_protocol_effect(
            card_value,
            player_state,
            &player_address,
            remaining_accounts,
            &owner,
        )?;
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

/// Apply a protocol card effect.
/// - RUG_PULL: Remove the highest Alpha card from a valid target
/// - AIRDROP: Skipped on-chain (off-chain dealer handles token bonus)
/// - VAMPIRE_ATTACK: Steal a card from a valid target
fn apply_protocol_effect(
    effect: u8,
    player_state: &AccountView,
    player_address: &[u8; 32],
    remaining: &[AccountView],
    owner: &pinocchio::Address,
) -> ProgramResult {
    match effect {
        RUG_PULL => {
            if let Some(target) = find_valid_target(remaining, owner, player_address)? {
                let mut target_data = target.try_borrow_mut()?;
                let mut target_ps = PlayerStateMut::from_bytes(&mut target_data);

                let hand_size = target_ps.as_ref().hand_size();
                let mut best_idx = None;
                let mut best_val = 0u8;
                for i in 0..hand_size as usize {
                    let c = target_ps.as_ref().card_at(i);
                    if c.card_type == ALPHA && c.value > best_val {
                        best_val = c.value;
                        best_idx = Some(i);
                    }
                }

                if let Some(idx) = best_idx {
                    for i in idx..(hand_size as usize - 1) {
                        let next = target_ps.as_ref().card_at(i + 1);
                        target_ps.set_card_at(i, &next);
                    }
                    target_ps.set_hand_size(hand_size - 1);
                }
            }
        }
        crate::state::card::AIRDROP => {
            // Airdrop bonus is handled off-chain by the dealer service.
            // On-chain, drawing the card is the only effect. The dealer
            // watches for Airdrop cards in transaction logs and credits
            // the player's token account directly.
        }
        VAMPIRE_ATTACK => {
            if let Some(target) = find_valid_target(remaining, owner, player_address)? {
                // Read the stolen card from target FIRST, then drop target borrow,
                // then borrow player_state to add it. This avoids double-borrow
                // if target == player_state (which find_valid_target prevents,
                // but we're defensive).
                let stolen;
                {
                    let mut target_data = target.try_borrow_mut()?;
                    let mut target_ps = PlayerStateMut::from_bytes(&mut target_data);

                    let target_hand_size = target_ps.as_ref().hand_size();
                    if target_hand_size == 0 {
                        return Ok(());
                    }
                    stolen = target_ps.as_ref().card_at(target_hand_size as usize - 1);
                    target_ps.set_hand_size(target_hand_size - 1);
                }
                // target borrow dropped

                let mut ps_data = player_state.try_borrow_mut()?;
                let mut ps = PlayerStateMut::from_bytes(&mut ps_data);
                ps.push_card(&stolen);
            }
        }
        _ => {} // Unknown protocol effect — skip
    }

    Ok(())
}

/// Find the first account in remaining that is a valid, active PlayerState
/// owned by the program and NOT the current player.
fn find_valid_target<'a>(
    remaining: &'a [AccountView],
    owner: &pinocchio::Address,
    player_address: &[u8; 32],
) -> Result<Option<&'a AccountView>, ProgramError> {
    for account in remaining {
        if !account.owned_by(owner) {
            continue;
        }
        let data = account.try_borrow_mut()?;
        if data.len() < 110 || data[0] != PLAYER_STATE_DISCRIMINATOR {
            continue;
        }
        let ps = PlayerState::from_bytes(&data);
        // Skip the current player (prevents self-targeting and double-borrow)
        if ps.player() == player_address {
            continue;
        }
        if ps.is_active() {
            drop(data);
            return Ok(Some(account));
        }
    }
    Ok(None)
}

fn advance_turn(gs: &mut GameSessionMut<'_>, player_count: usize) {
    if player_count == 0 {
        return;
    }
    let current = gs.as_ref().current_turn_index() as usize;
    let next = (current + 1) % player_count;
    gs.set_current_turn_index(next as u8);
}
