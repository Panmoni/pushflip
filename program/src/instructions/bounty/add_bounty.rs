//! add_bounty — append a new bounty to the board.
//!
//! Accounts:
//!   0. `[signer]`           authority — must match game_session.authority
//!   1. `[]`                 game_session — for authority check
//!   2. `[writable]`         bounty_board
//!
//! Instruction data:
//!   [0]    bounty_type (u8) — 0=SEVEN_CARD_WIN, 1=HIGH_SCORE, 2=SURVIVOR, 3=COMEBACK
//!   [1..9] reward_amount (u64, LE)
//!
//! For HIGH_SCORE bounties (type=1), the reward_amount field doubles as
//! the score threshold the player must meet — see [crate::instructions::bounty]
//! module docs for the rationale.

use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use crate::{
    errors::PushFlipError,
    state::{
        bounty::{
            BountyBoard, BountyBoardMut, BOUNTY_BOARD_DISCRIMINATOR, COMEBACK, HIGH_SCORE,
            MAX_BOUNTIES,
        },
        game_session::{GameSession, GAME_SESSION_DISCRIMINATOR},
    },
    utils::accounts::{verify_account_owner, verify_signer, verify_writable},
    ID,
};

const ADD_BOUNTY_DATA_LEN: usize = 9;

pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let [authority, game_session, bounty_board] = &accounts[..3] else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if data.len() < ADD_BOUNTY_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let bounty_type = data[0];
    let reward_amount = u64::from_le_bytes(data[1..9].try_into().unwrap());

    // Bounty type must be one of the four known constants
    if bounty_type > COMEBACK {
        return Err(PushFlipError::InvalidInstruction.into());
    }

    // Heavy-duty review #5 fix M4: HIGH_SCORE bounties overload
    // `reward_amount` as the score threshold the player must meet. A
    // threshold of 0 means *any* stayed player passes (`score >= 0` is
    // always true), which is almost certainly an authority misconfiguration.
    // Reject it explicitly to surface the foot-gun at add-time rather than
    // letting an unclaimable-by-design bounty be claimable by everyone.
    if bounty_type == HIGH_SCORE && reward_amount == 0 {
        return Err(PushFlipError::InvalidInstruction.into());
    }

    verify_signer(authority)?;
    verify_writable(bounty_board)?;

    let owner = pinocchio::Address::new_from_array(ID);
    verify_account_owner(game_session, &owner)?;
    verify_account_owner(bounty_board, &owner)?;

    // --- Verify authority owns the game session ---
    let logged_game_id;
    {
        let gs_data = game_session.try_borrow()?;
        let gs = GameSession::from_bytes(&gs_data);
        if gs.discriminator() != GAME_SESSION_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        if gs.authority() != authority.address().as_array() {
            return Err(ProgramError::MissingRequiredSignature);
        }
        logged_game_id = gs.game_id();
    }

    // --- Verify bounty_board references this game_session ---
    {
        let bb_data = bounty_board.try_borrow()?;
        let bb = BountyBoard::from_bytes(&bb_data);
        if bb.discriminator() != BOUNTY_BOARD_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        if bb.game_session() != game_session.address().as_array() {
            return Err(PushFlipError::InvalidPda.into());
        }
    }

    // --- Append bounty ---
    let mut bb_data = bounty_board.try_borrow_mut()?;
    let mut bb = BountyBoardMut::from_bytes(&mut bb_data);
    let count = bb.as_ref().bounty_count() as usize;
    if count >= MAX_BOUNTIES {
        // Heavy-duty review #5 fix M2: was previously
        // `MaxPlayersReached`, which describes a player_count overflow,
        // not a bounty_count overflow.
        return Err(PushFlipError::MaxBountiesReached.into());
    }

    bb.set_bounty_type(count, bounty_type);
    bb.set_bounty_reward(count, reward_amount);
    bb.set_bounty_is_active(count, true);
    bb.set_bounty_claimed_by(count, &[0u8; 32]);
    bb.set_bounty_count((count + 1) as u8);
    drop(bb_data);

    pinocchio_log::log!(
        "pushflip:add_bounty:game_id={}|index={}|bounty_type={}|amount={}",
        logged_game_id,
        count,
        bounty_type,
        reward_amount
    );

    Ok(())
}
