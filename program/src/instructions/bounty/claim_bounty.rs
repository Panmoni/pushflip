//! claim_bounty — player marks themselves as the claimant of an active bounty.
//!
//! Does NOT transfer tokens. Records the claim and the claimer's address
//! on chain; the actual reward payout is the authority's responsibility
//! (off-chain or via a separate token transfer instruction). See the
//! [bounty module docs](crate::instructions::bounty) for the rationale.
//!
//! Accounts:
//!   0. `[signer]`           player
//!   1. `[]`                 game_session — for player verification
//!   2. `[]`                 player_state — for win-condition checks
//!   3. `[writable]`         bounty_board
//!
//! Instruction data:
//!   [0] bounty_index (u8) — which bounty in the board the player is claiming

use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use crate::{
    errors::PushFlipError,
    state::{
        bounty::{
            BountyBoard, BountyBoardMut, BOUNTY_BOARD_DISCRIMINATOR, COMEBACK, HIGH_SCORE,
            SEVEN_CARD_WIN, SURVIVOR,
        },
        game_session::{GameSession, GAME_SESSION_DISCRIMINATOR, MAX_PLAYERS},
        player_state::{PlayerState, PLAYER_STATE_DISCRIMINATOR, STAYED},
    },
    utils::{
        accounts::{verify_account_owner, verify_signer, verify_writable},
        events::HexPubkey,
    },
    ID,
};

// Heavy-duty review #5 fix C1: claim_bounty must verify the player_state
// belongs to THIS game (not a different game where the player happens to
// have qualifying win-condition state). Without this cross-check, an
// attacker who participates in BOTH game A and game B can pass game A's
// player_state along with game B's game_session and bounty_board, and
// claim a game B bounty using their game A qualifications. The fix is to
// capture `gs.game_id()` from the game_session borrow block and compare
// it to `ps.game_id()` in the player_state borrow block.
//
// Also fix M1: claim_bounty must check `round_active = false`. Mid-round
// claims let the first player to call stay() snipe a SURVIVOR bounty
// before other players have a chance to act. The fix is a single line
// inside the existing game_session borrow block.

pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let [player, game_session, player_state, bounty_board] = &accounts[..4] else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }
    let bounty_index = data[0] as usize;

    verify_signer(player)?;
    verify_writable(bounty_board)?;

    let owner = pinocchio::Address::new_from_array(ID);
    verify_account_owner(game_session, &owner)?;
    verify_account_owner(player_state, &owner)?;
    verify_account_owner(bounty_board, &owner)?;

    // --- Verify the game state, find the player in turn_order, capture
    //     the game_id for the cross-game check below ---
    let gs_game_id;
    {
        let gs_data = game_session.try_borrow()?;
        let gs = GameSession::from_bytes(&gs_data);
        if gs.discriminator() != GAME_SESSION_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }

        // Heavy-duty review #5 fix M1: refuse mid-round claims. The
        // SURVIVOR / SEVEN_CARD_WIN / HIGH_SCORE / COMEBACK win
        // conditions are all checked against player_state, but in
        // first-come-first-served bounties (like SURVIVOR) the first
        // player to call stay() could otherwise snipe the bounty before
        // other players have a chance to act. Restricting claims to
        // post-round closes that race.
        if gs.round_active() {
            return Err(PushFlipError::RoundAlreadyActive.into());
        }

        gs_game_id = gs.game_id();

        let player_count = gs.player_count() as usize;
        let mut found = false;
        for i in 0..player_count.min(MAX_PLAYERS) {
            if gs.turn_order_slot(i) == player.address().as_array() {
                found = true;
                break;
            }
        }
        if !found {
            return Err(PushFlipError::InvalidInstruction.into());
        }
    }

    // --- Verify the bounty_board belongs to this game_session ---
    let bounty_count;
    let bounty_type;
    let bounty_reward;
    let bounty_active;
    {
        let bb_data = bounty_board.try_borrow()?;
        let bb = BountyBoard::from_bytes(&bb_data);
        if bb.discriminator() != BOUNTY_BOARD_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        if bb.game_session() != game_session.address().as_array() {
            return Err(PushFlipError::InvalidPda.into());
        }
        bounty_count = bb.bounty_count() as usize;
        if bounty_index >= bounty_count {
            return Err(PushFlipError::InvalidInstruction.into());
        }
        bounty_type = bb.bounty_type(bounty_index);
        bounty_reward = bb.bounty_reward(bounty_index);
        bounty_active = bb.bounty_is_active(bounty_index);
    }

    if !bounty_active {
        return Err(PushFlipError::InvalidInstruction.into());
    }

    // --- Verify the player_state belongs to THIS player AND THIS game,
    //     then check the win condition ---
    {
        let ps_data = player_state.try_borrow()?;
        if ps_data[0] != PLAYER_STATE_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        let ps = PlayerState::from_bytes(&ps_data);
        if ps.player() != player.address().as_array() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        // Heavy-duty review #5 fix C1: cross-game player_state check.
        // Without this, an attacker who is in BOTH game A and game B can
        // claim a bounty on game B using game A's player_state (where
        // they have qualifying win-condition state). The PDA derivation
        // for `player_state` already ties (game_id, player) to the
        // address, so checking `ps.game_id() == gs.game_id()` is enough
        // to bind the player_state to this game.
        if ps.game_id() != gs_game_id {
            return Err(PushFlipError::PlayerStateMismatch.into());
        }

        // Win condition check
        let condition_met = match bounty_type {
            SEVEN_CARD_WIN => ps.inactive_reason() == STAYED && ps.hand_size() >= 7,
            HIGH_SCORE => {
                // reward_amount doubles as the threshold for HIGH_SCORE
                ps.inactive_reason() == STAYED && ps.score() >= bounty_reward
            }
            SURVIVOR => ps.inactive_reason() == STAYED,
            COMEBACK => ps.inactive_reason() == STAYED && ps.has_used_second_chance(),
            _ => return Err(PushFlipError::InvalidInstruction.into()),
        };

        if !condition_met {
            return Err(PushFlipError::PlayerNotActive.into());
        }
    }

    // --- Mark the bounty as claimed ---
    let mut bb_data = bounty_board.try_borrow_mut()?;
    let mut bb = BountyBoardMut::from_bytes(&mut bb_data);
    bb.set_bounty_is_active(bounty_index, false);
    bb.set_bounty_claimed_by(bounty_index, player.address().as_array());
    drop(bb_data);

    pinocchio_log::log!(
        "pushflip:claim_bounty:claimer={}|game_id={}|index={}|bounty_type={}|amount={}",
        HexPubkey(player.address().as_array()),
        gs_game_id,
        bounty_index,
        bounty_type,
        bounty_reward
    );

    Ok(())
}
