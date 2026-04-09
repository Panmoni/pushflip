use pinocchio::{cpi::Seed, error::ProgramError, AccountView, ProgramResult};
use pinocchio_token::instructions::Transfer;

use crate::{
    errors::PushFlipError,
    state::{
        game_session::{GameSession, GameSessionMut, GAME_SESSION_DISCRIMINATOR},
        player_state::{PlayerState, PLAYER_STATE_DISCRIMINATOR, STAYED},
    },
    utils::{
        accounts::{verify_account_owner, verify_signer, verify_writable},
        constants::VAULT_SEED,
    },
    ID,
};

/// Process the EndRound instruction.
///
/// Determines the winner, distributes the pot (minus treasury rake),
/// and resets round state.
///
/// Accounts:
///   0. `[writable]`  game_session
///   1. `[signer]`    caller — must be authority, dealer, or a player in turn_order
///   2. `[writable]`  vault — game's token vault PDA (for payout transfers)
///   3. `[writable]`  winner_token_account — winner's $FLIP ATA (or zero-address if all busted)
///   4. `[writable]`  treasury_token_account — treasury $FLIP ATA
///   5. `[]`          token_program
///   6..N `[]`        player_states — must match turn_order in order
pub fn process(accounts: &[AccountView], _data: &[u8]) -> ProgramResult {
    if accounts.len() < 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let game_session = &accounts[0];
    let caller = &accounts[1];
    let vault = &accounts[2];
    let winner_token_account = &accounts[3];
    let treasury_token_account = &accounts[4];
    let token_program = &accounts[5];
    let player_accounts = &accounts[6..];

    let owner = pinocchio::Address::new_from_array(ID);
    verify_account_owner(game_session, &owner)?;
    verify_writable(game_session)?;
    verify_signer(caller)?;
    verify_writable(vault)?;

    if token_program.address() != &pinocchio_token::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let player_count;
    let pot_amount;
    let treasury_fee_bps;
    let vault_bump;
    {
        let gs_data = game_session.try_borrow_mut()?;
        let gs = GameSession::from_bytes(&gs_data);

        if gs.discriminator() != GAME_SESSION_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        if !gs.round_active() {
            return Err(PushFlipError::RoundNotActive.into());
        }

        player_count = gs.player_count() as usize;
        if player_accounts.len() < player_count {
            return Err(ProgramError::NotEnoughAccountKeys);
        }

        // Verify caller authorization
        let caller_addr = caller.address().as_array();
        let is_authorized = caller_addr == gs.authority()
            || caller_addr == gs.dealer()
            || (0..player_count).any(|i| gs.turn_order_slot(i) == caller_addr);

        if !is_authorized {
            return Err(ProgramError::MissingRequiredSignature);
        }

        // Verify each player_state's stored player key matches turn_order
        for i in 0..player_count {
            let ps_data = player_accounts[i].try_borrow_mut()?;
            if ps_data.len() < 34 || ps_data[0] != PLAYER_STATE_DISCRIMINATOR {
                return Err(ProgramError::InvalidAccountData);
            }
            let stored_player: &[u8] = &ps_data[2..34];
            if stored_player != gs.turn_order_slot(i) {
                return Err(PushFlipError::PlayerStateMismatch.into());
            }
        }

        // Verify vault matches stored vault
        if gs.vault() != &[0u8; 32] && vault.address().as_array() != gs.vault() {
            return Err(ProgramError::InvalidAccountData);
        }

        pot_amount = gs.pot_amount();
        treasury_fee_bps = gs.treasury_fee_bps();
        vault_bump = gs.vault_bump();
    }

    // --- Check all players are inactive, find winner ---
    let mut highest_score: u64 = 0;
    let mut _winner_index: Option<usize> = None;
    let mut all_busted = true;

    for i in 0..player_count {
        let ps_account = &player_accounts[i];
        verify_account_owner(ps_account, &owner)?;

        let ps_data = ps_account.try_borrow_mut()?;
        if ps_data.len() < 110 || ps_data[0] != PLAYER_STATE_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }

        let ps = PlayerState::from_bytes(&ps_data);
        if ps.is_active() {
            return Err(PushFlipError::PlayersStillActive.into());
        }

        if ps.inactive_reason() == STAYED {
            all_busted = false;
            let score = ps.score();
            if score > highest_score {
                highest_score = score;
                _winner_index = Some(i);
            }
        }
    }

    // --- Build vault PDA signer (used by both distribution and rollover-sweep paths) ---
    let game_session_key = *game_session.address().as_array();
    let vault_bump_bytes = [vault_bump];
    let vault_seeds: [Seed; 3] = [
        Seed::from(VAULT_SEED),
        Seed::from(game_session_key.as_slice()),
        Seed::from(vault_bump_bytes.as_slice()),
    ];
    let vault_signer: [pinocchio::cpi::Signer; 1] = [(&vault_seeds).into()];

    // --- Distribute tokens ---
    if !all_busted && pot_amount > 0 {
        // Calculate rake
        let rake = pot_amount
            .checked_mul(treasury_fee_bps as u64)
            .ok_or(PushFlipError::ArithmeticOverflow)?
            / 10_000;
        let winner_payout = pot_amount
            .checked_sub(rake)
            .ok_or(PushFlipError::ArithmeticOverflow)?;

        // Transfer rake to treasury
        if rake > 0 {
            verify_writable(treasury_token_account)?;
            Transfer {
                from: vault,
                to: treasury_token_account,
                authority: vault,
                amount: rake,
            }
            .invoke_signed(&vault_signer)?;
        }

        // Transfer winnings to winner
        if winner_payout > 0 {
            verify_writable(winner_token_account)?;
            Transfer {
                from: vault,
                to: winner_token_account,
                authority: vault,
                amount: winner_payout,
            }
            .invoke_signed(&vault_signer)?;
        }
    }

    // --- Update GameSession ---
    {
        let mut gs_data = game_session.try_borrow_mut()?;
        let mut gs = GameSessionMut::from_bytes(&mut gs_data);

        if all_busted {
            let rollover = gs.as_ref().rollover_count();
            if rollover >= 10 {
                // Rollover cap reached — sweep pot to treasury to prevent
                // permanent token lock. Authority can redistribute manually.
                if pot_amount > 0 {
                    verify_writable(treasury_token_account)?;
                    Transfer {
                        from: vault,
                        to: treasury_token_account,
                        authority: vault,
                        amount: pot_amount,
                    }
                    .invoke_signed(&vault_signer)?;
                }
                gs.set_pot_amount(0);
                gs.set_rollover_count(0);
            } else {
                gs.set_rollover_count(rollover.saturating_add(1));
            }
        } else {
            // Winner paid out above — reset pot
            gs.set_pot_amount(0);
            gs.set_rollover_count(0);
        }

        gs.set_round_active(false);
        gs.set_deck_committed(false);
        gs.set_draw_counter(0);
    }

    Ok(())
}
