use pinocchio::{error::ProgramError, AccountView, ProgramResult};
use pinocchio_token::instructions::Burn;

use crate::{
    errors::PushFlipError,
    state::{
        game_session::{GameSession, GAME_SESSION_DISCRIMINATOR},
        player_state::{PlayerStateMut, ACTIVE, BUST, PLAYER_STATE_DISCRIMINATOR},
    },
    utils::{
        accounts::{verify_account_owner, verify_signer, verify_writable},
        constants::SECOND_CHANCE_COST,
        events::HexPubkey,
    },
    ID,
};

/// Process the BurnSecondChance instruction.
///
/// Player burns $FLIP tokens to undo a bust — removes the bust card,
/// sets them back to active.
///
/// Accounts:
///   0. `[]`         game_session — read only; only checked for round_active
///   1. `[writable]` player_state
///   2. `[signer]`   player
///   3. `[writable]` player_token_account — player's $FLIP ATA
///   4. `[writable]` token_mint — $FLIP mint (for burn)
///   5. `[]`         token_program
pub fn process(accounts: &[AccountView], _data: &[u8]) -> ProgramResult {
    if accounts.len() < 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let [game_session, player_state, player, player_token_account, token_mint, token_program] =
        &accounts[..6]
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // --- Validate accounts ---
    let owner = pinocchio::Address::new_from_array(ID);
    verify_account_owner(game_session, &owner)?;
    verify_account_owner(player_state, &owner)?;
    verify_writable(player_state)?;
    verify_signer(player)?;
    verify_writable(player_token_account)?;
    verify_writable(token_mint)?;

    if token_program.address() != &pinocchio_token::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Verify game is in an active round
    let logged_game_id;
    {
        let gs_data = game_session.try_borrow()?;
        let gs = GameSession::from_bytes(&gs_data);
        if gs.discriminator() != GAME_SESSION_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        if !gs.round_active() {
            return Err(PushFlipError::RoundNotActive.into());
        }
        logged_game_id = gs.game_id();
    }

    // --- Validate player state ---
    {
        let mut ps_data = player_state.try_borrow_mut()?;
        if ps_data[0] != PLAYER_STATE_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }

        let mut ps = PlayerStateMut::from_bytes(&mut ps_data);

        if ps.as_ref().player() != player.address().as_array() {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if ps.as_ref().inactive_reason() != BUST {
            return Err(PushFlipError::NotBusted.into());
        }
        if ps.as_ref().has_used_second_chance() {
            return Err(PushFlipError::SecondChanceAlreadyUsed.into());
        }

        // --- Burn tokens ---
        Burn {
            account: player_token_account,
            mint: token_mint,
            authority: player,
            amount: SECOND_CHANCE_COST,
        }
        .invoke()?;

        // --- Remove bust card (last card) and reactivate ---
        ps.pop_card();
        ps.set_is_active(true);
        ps.set_inactive_reason(ACTIVE);
        ps.set_bust_card_value(0);
        ps.set_has_used_second_chance(true);
    }

    pinocchio_log::log!(
        "pushflip:burn_second_chance:player={}|game_id={}",
        HexPubkey(player.address().as_array()),
        logged_game_id
    );

    Ok(())
}
