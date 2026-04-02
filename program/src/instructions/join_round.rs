use pinocchio::{cpi::Seed, error::ProgramError, AccountView, Address, ProgramResult};

use crate::{
    errors::PushFlipError,
    state::{
        game_session::{GameSession, GameSessionMut, GAME_SESSION_DISCRIMINATOR, MAX_PLAYERS},
        player_state::{
            PlayerStateMut, ACTIVE, PLAYER_SEED, PLAYER_STATE_DISCRIMINATOR, PLAYER_STATE_SIZE,
        },
    },
    utils::accounts::{verify_account_owner, verify_signer, verify_writable},
    ID,
};

/// Join round instruction data layout:
/// [0]     bump — PlayerState PDA bump seed
const JOIN_DATA_LEN: usize = 1;

/// Process the JoinRound instruction.
///
/// Creates a PlayerState PDA and adds the player to the turn order.
///
/// Accounts:
///   0. `[writable]`         game_session
///   1. `[writable]`         player_state — PDA: ["player", game_id, player]
///   2. `[writable, signer]` player
///   3. `[]`                 system_program
pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let [game_session, player_state, player, system_program] = &accounts[..4] else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if data.len() < JOIN_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let bump = data[0];

    // --- Validate accounts ---
    let owner = pinocchio::Address::new_from_array(ID);
    verify_account_owner(game_session, &owner)?;
    verify_writable(game_session)?;
    verify_writable(player_state)?;
    verify_signer(player)?;
    verify_writable(player)?;

    if system_program.address() != &pinocchio_system::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Read game state
    let game_id;
    let player_count;
    {
        let gs_data = game_session.try_borrow_mut()?;
        let gs = GameSession::from_bytes(&gs_data);

        if gs.discriminator() != GAME_SESSION_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        if gs.round_active() {
            return Err(PushFlipError::RoundAlreadyActive.into());
        }

        player_count = gs.player_count();
        if player_count as usize >= MAX_PLAYERS {
            return Err(PushFlipError::MaxPlayersReached.into());
        }

        // Check player not already in turn order
        for i in 0..player_count as usize {
            if gs.turn_order_slot(i) == player.address().as_array() {
                return Err(PushFlipError::PlayerAlreadyJoined.into());
            }
        }

        game_id = gs.game_id();
    }

    // Verify PlayerState PDA
    let program_id = solana_address::Address::new_from_array(ID);
    let game_id_bytes = game_id.to_le_bytes();
    let expected_pda = solana_address::Address::derive_address(
        &[PLAYER_SEED, &game_id_bytes, player.address().as_ref()],
        Some(bump),
        &program_id,
    );

    if player_state.address().as_array() != expected_pda.as_array() {
        return Err(PushFlipError::InvalidPda.into());
    }

    // --- Create PlayerState PDA ---
    let pinocchio_owner = Address::new_from_array(ID);
    let bump_seed = [bump];
    let signer_seeds: [Seed; 4] = [
        Seed::from(PLAYER_SEED),
        Seed::from(game_id_bytes.as_slice()),
        Seed::from(player.address().as_ref()),
        Seed::from(bump_seed.as_slice()),
    ];

    pinocchio_system::create_account_with_minimum_balance_signed(
        player_state,
        PLAYER_STATE_SIZE,
        &pinocchio_owner,
        player,
        None,
        &[(&signer_seeds).into()],
    )?;

    // --- Initialize PlayerState ---
    {
        let mut ps_data = player_state.try_borrow_mut()?;
        let mut ps = PlayerStateMut::from_bytes(&mut ps_data);

        ps.set_discriminator(PLAYER_STATE_DISCRIMINATOR);
        ps.set_bump(bump);
        ps.set_player(player.address().as_array());
        ps.set_game_id(game_id);
        ps.set_hand_size(0);
        ps.set_is_active(true);
        ps.set_inactive_reason(ACTIVE);
        ps.set_bust_card_value(0);
        ps.set_score(0);
        ps.set_staked_amount(0); // Staking added in Phase 2
        ps.set_has_used_second_chance(false);
        ps.set_has_used_scry(false);
    }

    // --- Update GameSession turn order ---
    {
        let mut gs_data = game_session.try_borrow_mut()?;
        let mut gs = GameSessionMut::from_bytes(&mut gs_data);
        gs.set_turn_order_slot(player_count as usize, player.address().as_array());
        gs.set_player_count(player_count + 1);
    }

    Ok(())
}
