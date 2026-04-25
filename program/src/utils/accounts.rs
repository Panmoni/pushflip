use pinocchio::{error::ProgramError, AccountView, Address};

use crate::errors::PushFlipError;

/// Verify that an account is owned by the expected program.
pub fn verify_account_owner(account: &AccountView, expected: &Address) -> Result<(), ProgramError> {
    // Safety: owner() reads the owner field from the account's metadata.
    // This is safe as long as the AccountView was parsed from valid input,
    // which the runtime guarantees for accounts passed to process_instruction.
    if unsafe { account.owner() } != expected {
        return Err(PushFlipError::InvalidAccountOwner.into());
    }
    Ok(())
}

/// Verify that an account is a signer.
pub fn verify_signer(account: &AccountView) -> Result<(), ProgramError> {
    if !account.is_signer() {
        return Err(PushFlipError::MissingSigner.into());
    }
    Ok(())
}

/// Verify that an account is writable.
pub fn verify_writable(account: &AccountView) -> Result<(), ProgramError> {
    if !account.is_writable() {
        return Err(PushFlipError::MissingWritable.into());
    }
    Ok(())
}

/// Verify that an SPL Token Account holds the expected mint and is owned
/// (in the SPL Token sense) by the expected wallet.
pub fn verify_token_account(
    account: &AccountView,
    expected_mint: &[u8; 32],
    expected_owner: &[u8; 32],
) -> Result<(), ProgramError> {
    if unsafe { account.owner() } != &pinocchio_token::ID {
        return Err(PushFlipError::InvalidTokenAccount.into());
    }
    let data = account.try_borrow()?;
    if data.len() < 64 {
        return Err(PushFlipError::InvalidTokenAccount.into());
    }
    if &data[0..32] != expected_mint {
        return Err(PushFlipError::InvalidTokenAccount.into());
    }
    if &data[32..64] != expected_owner {
        return Err(PushFlipError::InvalidTokenAccount.into());
    }
    Ok(())
}
