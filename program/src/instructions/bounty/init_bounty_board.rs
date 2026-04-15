//! init_bounty_board — create the BountyBoard PDA for a game session.
//!
//! Accounts:
//!   0. `[writable, signer]` payer — funds rent (typically the authority)
//!   1. `[]`                 game_session — must be owned by program; payer must equal authority
//!   2. `[writable]`         bounty_board — PDA at ["bounty", game_session_address]
//!   3. `[]`                 system_program
//!
//! Instruction data:
//!   [0] bump — bounty board PDA bump (client supplies for cheap derivation)

use pinocchio::{cpi::Seed, error::ProgramError, AccountView, Address, ProgramResult};

use crate::{
    errors::PushFlipError,
    state::{
        bounty::{BountyBoardMut, BOUNTY_BOARD_DISCRIMINATOR, BOUNTY_BOARD_SIZE, BOUNTY_SEED},
        game_session::{GameSession, GAME_SESSION_DISCRIMINATOR},
    },
    utils::{
        accounts::{verify_account_owner, verify_signer, verify_writable},
        events::HexPubkey,
    },
    ID,
};

pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let [payer, game_session, bounty_board, system_program] = &accounts[..4] else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }
    let bump = data[0];

    verify_signer(payer)?;
    verify_writable(payer)?;
    verify_writable(bounty_board)?;

    let owner = pinocchio::Address::new_from_array(ID);
    verify_account_owner(game_session, &owner)?;

    if system_program.address() != &pinocchio_system::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // --- Verify the payer is the authority of this game ---
    let logged_game_id;
    {
        let gs_data = game_session.try_borrow()?;
        let gs = GameSession::from_bytes(&gs_data);
        if gs.discriminator() != GAME_SESSION_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        if gs.authority() != payer.address().as_array() {
            return Err(ProgramError::MissingRequiredSignature);
        }
        logged_game_id = gs.game_id();
    }

    // --- Verify the bounty board PDA derivation ---
    let game_session_key = *game_session.address().as_array();
    let program_id = solana_address::Address::new_from_array(ID);
    let expected_pda = solana_address::Address::derive_address(
        &[BOUNTY_SEED, &game_session_key],
        Some(bump),
        &program_id,
    );
    if bounty_board.address().as_array() != expected_pda.as_array() {
        return Err(PushFlipError::InvalidPda.into());
    }

    // --- Create the BountyBoard PDA account ---
    let pinocchio_owner = Address::new_from_array(ID);
    let bump_seed = [bump];
    let signer_seeds: [Seed; 3] = [
        Seed::from(BOUNTY_SEED),
        Seed::from(game_session_key.as_slice()),
        Seed::from(bump_seed.as_slice()),
    ];

    pinocchio_system::create_account_with_minimum_balance_signed(
        bounty_board,
        BOUNTY_BOARD_SIZE,
        &pinocchio_owner,
        payer,
        None,
        &[(&signer_seeds).into()],
    )?;

    // --- Initialize state ---
    let mut bb_data = bounty_board.try_borrow_mut()?;
    let mut bb = BountyBoardMut::from_bytes(&mut bb_data);
    bb.set_discriminator(BOUNTY_BOARD_DISCRIMINATOR);
    bb.set_bump(bump);
    bb.set_game_session(&game_session_key);
    bb.set_bounty_count(0);
    drop(bb_data);

    pinocchio_log::log!(
        "pushflip:init_bounty_board:game_id={}|board={}",
        logged_game_id,
        HexPubkey(bounty_board.address().as_array())
    );

    Ok(())
}
