use pinocchio::{cpi::Seed, error::ProgramError, AccountView, Address, ProgramResult};

use crate::{
    errors::PushFlipError,
    state::game_session::{
        GameSessionMut, GAME_SEED, GAME_SESSION_DISCRIMINATOR, GAME_SESSION_SIZE, MAX_PLAYERS,
    },
    utils::{
        accounts::{verify_signer, verify_writable},
        constants::{DEFAULT_TREASURY_FEE_BPS, VAULT_SEED},
        events::HexPubkey,
    },
    ID,
};

/// Initialize instruction data layout:
/// [0..8]   game_id (u64, little-endian)
/// [8]      bump — PDA bump seed (client derives this off-chain)
/// [9..11]  treasury_fee_bps (u16, LE) — optional, defaults to 200 (2%)
///
/// Process the Initialize instruction.
///
/// Creates a new GameSession PDA account and sets initial state.
/// Derives the vault PDA address and stores it + bump for later use.
///
/// Accounts:
///   0. `[writable, signer]` authority — pays for account creation
///   1. `[writable]`         game_session — PDA: ["game", game_id.to_le_bytes()]
///   2. `[]`                 house — The House AI wallet address
///   3. `[]`                 dealer — ZK dealer service address
///   4. `[]`                 treasury — Treasury token account
///   5. `[]`                 token_mint — $FLIP token mint
///   6. `[]`                 system_program
pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < 7 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let [authority, game_session, house, dealer, treasury, token_mint, system_program] =
        &accounts[..7]
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if data.len() < 10 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let game_id = u64::from_le_bytes(data[..8].try_into().unwrap());
    let bump = data[8];
    let vault_bump = data[9];

    let treasury_fee_bps: u16 = if data.len() >= 12 {
        u16::from_le_bytes(data[10..12].try_into().unwrap())
    } else {
        DEFAULT_TREASURY_FEE_BPS
    };

    if treasury_fee_bps > 9999 {
        return Err(PushFlipError::InvalidTreasuryFeeBps.into());
    }

    verify_signer(authority)?;
    verify_writable(authority)?;
    verify_writable(game_session)?;

    if system_program.address() != &pinocchio_system::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Derive game PDA
    let program_id = solana_address::Address::new_from_array(ID);
    let game_id_bytes = game_id.to_le_bytes();
    let expected_pda = solana_address::Address::derive_address(
        &[GAME_SEED, &game_id_bytes],
        Some(bump),
        &program_id,
    );

    if game_session.address().as_array() != expected_pda.as_array() {
        return Err(PushFlipError::InvalidPda.into());
    }

    // Derive vault PDA address using client-provided bump
    // Seeds: ["vault", game_session_address]
    let game_session_key = *expected_pda.as_array();
    let vault_pda = solana_address::Address::derive_address(
        &[VAULT_SEED, &game_session_key],
        Some(vault_bump),
        &program_id,
    );

    // --- Create the GameSession PDA account ---
    let owner = Address::new_from_array(ID);
    let bump_seed = [bump];
    let signer_seeds: [Seed; 3] = [
        Seed::from(GAME_SEED),
        Seed::from(game_id_bytes.as_slice()),
        Seed::from(bump_seed.as_slice()),
    ];

    pinocchio_system::create_account_with_minimum_balance_signed(
        game_session,
        GAME_SESSION_SIZE,
        &owner,
        authority,
        None,
        &[(&signer_seeds).into()],
    )?;

    // --- Write initial state ---
    let mut data_ref = game_session.try_borrow_mut()?;
    let mut gs = GameSessionMut::from_bytes(&mut data_ref);

    gs.set_discriminator(GAME_SESSION_DISCRIMINATOR);
    gs.set_bump(bump);
    gs.set_game_id(game_id);
    gs.set_authority(authority.address().as_array());
    gs.set_house(house.address().as_array());
    gs.set_dealer(dealer.address().as_array());
    gs.set_treasury(treasury.address().as_array());
    gs.set_token_mint(token_mint.address().as_array());
    gs.set_vault(vault_pda.as_array());
    gs.set_vault_bump(vault_bump);
    // Empty turn_order — players (including the House AI) are added via
    // join_round. The `house` field at offset 42 still records the AI
    // identity for off-chain code; on-chain it's just another player.
    gs.set_player_count(0);
    for i in 0..MAX_PLAYERS {
        gs.set_turn_order_slot(i, &[0u8; 32]);
    }
    gs.set_current_turn_index(0);
    gs.set_round_active(false);
    gs.set_round_number(0);
    gs.set_pot_amount(0);
    gs.set_merkle_root(&[0u8; 32]);
    gs.set_deck_committed(false);
    gs.set_draw_counter(0);
    gs.set_treasury_fee_bps(treasury_fee_bps);
    gs.set_rollover_count(0);
    gs.set_last_action_slot(0);

    pinocchio_log::log!(
        "pushflip:initialize:authority={}|game_id={}|fee_bps={}",
        HexPubkey(authority.address().as_array()),
        game_id,
        treasury_fee_bps
    );

    Ok(())
}
