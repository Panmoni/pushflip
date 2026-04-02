use pinocchio::{
    error::ProgramError, default_allocator, default_panic_handler, program_entrypoint,
    AccountView, Address, ProgramResult,
};

mod errors;
mod events;
mod instructions;
mod state;
mod utils;
mod zk;

pinocchio_pubkey::declare_id!("3UvVHnAbb1UtWVzDh4SK2RvFc3Fhe49ub7e8CHz8LkEo");

default_allocator!();
default_panic_handler!();
program_entrypoint!(process_instruction);

pub fn process_instruction(
    _program_id: &Address,
    _accounts: &[AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let discriminator = instruction_data
        .first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    match discriminator {
        0 => instructions::initialize::process(_accounts, &instruction_data[1..]),
        1 => instructions::commit_deck::process(_accounts, &instruction_data[1..]),
        2 => instructions::join_round::process(_accounts, &instruction_data[1..]),
        3 => instructions::start_round::process(_accounts, &instruction_data[1..]),
        4 => instructions::hit::process(_accounts, &instruction_data[1..]),
        5 => instructions::stay::process(_accounts, &instruction_data[1..]),
        6 => instructions::end_round::process(_accounts, &instruction_data[1..]),
        7 => instructions::close_game::process(_accounts, &instruction_data[1..]),
        8 => instructions::leave_game::process(_accounts, &instruction_data[1..]),
        // 9 => instructions::burn_second_chance::process(_accounts, &instruction_data[1..]),
        // 10 => instructions::burn_scry::process(_accounts, &instruction_data[1..]),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
