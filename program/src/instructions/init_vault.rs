//! init_vault — create the SPL token account at the vault PDA address.
//!
//! ## Why this exists
//!
//! `initialize` records the vault PDA address (derived from
//! `["vault", game_session_address]`) but does NOT create an SPL token
//! account at that address. The token account would have to be created
//! by someone signing for the vault PDA, and only the program can sign
//! for its own PDAs. Without this instruction, the
//! `vault_ready=true` branch in `join_round` (and the corresponding
//! token-payout branches in `end_round`) is structurally untestable on a
//! real validator — discovered during Phase 3A Task 3.A.2.
//!
//! `init_vault` fills that gap. It signs with the vault PDA seeds and
//! invokes:
//!
//!   1. `system::create_account` to allocate `TokenAccount::LEN` bytes
//!      with `TOKEN_PROGRAM_ID` as owner.
//!   2. `spl_token::initialize_account_3` (the modern variant that does
//!      not require a rent sysvar account) to set the token account's
//!      mint and owner. The owner (token-program authority) is the
//!      vault PDA address itself, which means the pushflip program can
//!      later sign for transfers from this account using the same vault
//!      seeds it used here.
//!
//! ## Lifetime
//!
//! This instruction is OPTIONAL. Games that don't need real token
//! transfers (e.g. our smoke tests with `vault_ready=false`) can skip
//! it entirely. The very first thing `join_round` does in the token
//! transfer path is `vault.data_len() > 0`, which is false until
//! `init_vault` runs.
//!
//! ## Accounts
//!
//!   0. `[writable, signer]` payer — funds the rent for the vault token account
//!   1. `[]`                 game_session — must already exist; reads vault, vault_bump, token_mint
//!   2. `[writable]`         vault — the vault PDA, will be created and initialized
//!   3. `[]`                 token_mint — must match game_session.token_mint
//!   4. `[]`                 system_program
//!   5. `[]`                 token_program

use pinocchio::{cpi::Seed, error::ProgramError, AccountView, Address, ProgramResult};
use pinocchio_token::{instructions::InitializeAccount3, state::TokenAccount};

use crate::{
    errors::PushFlipError,
    state::game_session::{GameSession, GAME_SESSION_DISCRIMINATOR},
    utils::{
        accounts::{verify_account_owner, verify_signer, verify_writable},
        constants::VAULT_SEED,
        events::HexPubkey,
    },
    ID,
};

pub fn process(accounts: &[AccountView], _data: &[u8]) -> ProgramResult {
    if accounts.len() < 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let [payer, game_session, vault, token_mint, system_program, token_program] = &accounts[..6]
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // --- Validate accounts ---
    verify_signer(payer)?;
    verify_writable(payer)?;
    verify_writable(vault)?;

    let owner = pinocchio::Address::new_from_array(ID);
    verify_account_owner(game_session, &owner)?;

    if system_program.address() != &pinocchio_system::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if token_program.address() != &pinocchio_token::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // --- Read game state and verify the vault address & mint ---
    let stored_vault;
    let stored_mint;
    let vault_bump;
    let stored_authority;
    let stored_game_id;
    {
        let gs_data = game_session.try_borrow()?;
        let gs = GameSession::from_bytes(&gs_data);

        if gs.discriminator() != GAME_SESSION_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }

        stored_vault = *gs.vault();
        stored_mint = *gs.token_mint();
        vault_bump = gs.vault_bump();
        stored_authority = *gs.authority();
        stored_game_id = gs.game_id();
    }

    // Heavy-duty review #5 fix H1: only the game authority may initialize
    // the vault. Without this check, ANY signer with ~0.00204 SOL can
    // call init_vault for any game and force it from "vault_ready=false"
    // (no-token testing mode) into "vault_ready=true" (real-token mode).
    // The change is irreversible — there's no on-chain instruction to
    // close the vault SPL token account because it's owned by the SPL
    // Token program with the vault PDA as authority. So unauthorized
    // init_vault calls are a one-way grief that flips game economics
    // without the authority's consent.
    if payer.address().as_array() != &stored_authority {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if stored_vault == [0u8; 32] {
        // Vault was never derived (shouldn't happen for properly initialized
        // games) — bail out rather than create a vault at an unexpected
        // address.
        return Err(PushFlipError::InvalidPda.into());
    }
    if vault.address().as_array() != &stored_vault {
        return Err(PushFlipError::InvalidPda.into());
    }
    if token_mint.address().as_array() != &stored_mint {
        return Err(ProgramError::InvalidAccountData);
    }

    // Refuse to re-create an existing vault. `data_len() > 0` means
    // someone (presumably this instruction in a prior tx) has already
    // allocated and initialized the token account.
    if vault.data_len() > 0 {
        return Err(PushFlipError::VaultAlreadyInitialized.into());
    }

    // --- Create the SPL token account at the vault PDA address ---
    // Sign with the vault PDA seeds so the runtime accepts the
    // create_account CPI on a PDA-owned address.
    let game_session_key = *game_session.address().as_array();
    let vault_bump_bytes = [vault_bump];
    let vault_signer_seeds: [Seed; 3] = [
        Seed::from(VAULT_SEED),
        Seed::from(game_session_key.as_slice()),
        Seed::from(vault_bump_bytes.as_slice()),
    ];

    pinocchio_system::create_account_with_minimum_balance_signed(
        vault,
        TokenAccount::LEN,
        &pinocchio_token::ID,
        payer,
        None,
        &[(&vault_signer_seeds).into()],
    )?;

    // --- Initialize the SPL token account ---
    // The owner (= token-program authority) is the vault PDA address
    // itself. end_round/burn instructions later sign with the same
    // vault PDA seeds to invoke transfers from this account.
    let vault_owner = Address::new_from_array(stored_vault);
    InitializeAccount3 {
        account: vault,
        mint: token_mint,
        owner: &vault_owner,
    }
    .invoke()?;

    pinocchio_log::log!(
        "pushflip:init_vault:game_id={}|vault={}",
        stored_game_id,
        HexPubkey(&stored_vault)
    );

    Ok(())
}
