use pinocchio::{cpi::Seed, error::ProgramError, AccountView, Address, ProgramResult};
use pinocchio_token::instructions::Transfer;

use crate::{
    errors::PushFlipError,
    state::{
        game_session::{GameSession, GameSessionMut, GAME_SESSION_DISCRIMINATOR, MAX_PLAYERS},
        player_state::{
            PlayerStateMut, ACTIVE, PLAYER_SEED, PLAYER_STATE_DISCRIMINATOR, PLAYER_STATE_SIZE,
        },
    },
    utils::{
        accounts::{verify_account_owner, verify_signer, verify_writable},
        constants::MIN_STAKE,
        events::HexPubkey,
    },
    ID,
};

/// Join round instruction data layout:
/// [0]     bump — PlayerState PDA bump seed
/// [1..9]  stake_amount (u64, LE) — must be >= MIN_STAKE
const JOIN_DATA_MIN_LEN: usize = 9;

/// Process the JoinRound instruction.
///
/// Creates a PlayerState PDA, transfers stake to the vault, and adds
/// the player to the turn order.
///
/// Accounts:
///   0. `[writable]`         game_session
///   1. `[writable]`         player_state — PDA: ["player", game_id, player]
///   2. `[writable, signer]` player
///   3. `[]`                 system_program
///   4. `[writable]`         player_token_account — player's $FLIP ATA
///   5. `[writable]`         vault — game's token vault PDA
///   6. `[]`                 token_program
pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < 7 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let [game_session, player_state, player, system_program, player_token_account, vault, token_program] =
        &accounts[..7]
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if data.len() < JOIN_DATA_MIN_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let bump = data[0];
    let stake_amount = u64::from_le_bytes(data[1..9].try_into().unwrap());

    if stake_amount < MIN_STAKE {
        return Err(PushFlipError::InsufficientStake.into());
    }

    // --- Validate accounts ---
    let owner = pinocchio::Address::new_from_array(ID);
    verify_account_owner(game_session, &owner)?;
    verify_writable(game_session)?;
    verify_writable(player_state)?;
    verify_signer(player)?;
    verify_writable(player)?;
    verify_writable(player_token_account)?;
    verify_writable(vault)?;

    if system_program.address() != &pinocchio_system::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if token_program.address() != &pinocchio_token::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Read game state
    let game_id;
    let player_count;
    let stored_vault;
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

        for i in 0..player_count as usize {
            if gs.turn_order_slot(i) == player.address().as_array() {
                return Err(PushFlipError::PlayerAlreadyJoined.into());
            }
        }

        game_id = gs.game_id();
        stored_vault = *gs.vault();
        let _stored_token_mint = *gs.token_mint();
    }

    // Verify vault matches stored vault (if set)
    if stored_vault != [0u8; 32] && vault.address().as_array() != &stored_vault {
        return Err(ProgramError::InvalidAccountData);
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

    // --- Transfer stake to vault ---
    // Transfer only if vault exists AND has data (is an initialized token account).
    // Vault address is derived at game init, but the token account may not be
    // created yet (requires off-chain setup with InitializeAccount CPI).
    let vault_ready = stored_vault != [0u8; 32] && vault.data_len() > 0;
    if vault_ready {
        Transfer {
            from: player_token_account,
            to: vault,
            authority: player,
            amount: stake_amount,
        }
        .invoke()?;
    }

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
        // Only record staked amount if tokens were actually transferred
        ps.set_staked_amount(if vault_ready { stake_amount } else { 0 });
        ps.set_has_used_second_chance(false);
        ps.set_has_used_scry(false);
    }

    // --- Update GameSession ---
    {
        let mut gs_data = game_session.try_borrow_mut()?;
        let mut gs = GameSessionMut::from_bytes(&mut gs_data);
        gs.set_turn_order_slot(player_count as usize, player.address().as_array());
        gs.set_player_count(player_count + 1);

        // Only increment pot if tokens were actually transferred
        if vault_ready {
            let pot = gs.as_ref().pot_amount();
            gs.set_pot_amount(
                pot.checked_add(stake_amount)
                    .ok_or(PushFlipError::ArithmeticOverflow)?,
            );
        }
    }

    // Log the *actual* staked amount: 0 when the program took the
    // vault_ready=false branch (legacy test-mode games where the
    // SPL token account at the vault PDA doesn't exist yet), else
    // the full stake the caller requested.
    let actual_stake = if vault_ready { stake_amount } else { 0 };
    pinocchio_log::log!(
        "pushflip:join_round:player={}|game_id={}|stake={}|player_count={}",
        HexPubkey(player.address().as_array()),
        game_id,
        actual_stake,
        player_count + 1
    );

    Ok(())
}
