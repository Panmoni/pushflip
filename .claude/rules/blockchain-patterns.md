# Blockchain Development Patterns — Pinocchio Native

## Framework

This project uses **Pinocchio** (zero-dependency native Rust by Anza), NOT Anchor. Do not generate Anchor patterns (`#[program]`, `#[account]`, `#[derive(Accounts)]`, `Context<T>`). All account handling is manual.

## Program Entrypoint

- Use `program_entrypoint!` (eager parsing) or `lazy_program_entrypoint!` (on-demand parsing) from Pinocchio
- Route instructions via a discriminator byte in instruction data
- Deserialize accounts manually from the accounts slice

## Account Handling

- Parse accounts from `&[AccountInfo]` — validate owner, signer, writable status, and key manually
- Use zero-copy patterns where possible for performance (Pinocchio's design goal)
- Serialize/deserialize account data with Borsh or manual byte layouts
- Always validate account ownership (`account.owner() == &expected_program_id`)
- Always check `is_signer` and `is_writable` where required

## PDAs (Program Derived Addresses)

- Derive PDAs with `Pubkey::find_program_address` or `Pubkey::create_program_address`
- Store bump seeds in account data to avoid recomputing
- Use descriptive, collision-resistant seed schemes (e.g., `[b"game", player.key().as_ref(), &game_id.to_le_bytes()]`)
- For PDA signing in CPIs, use `invoke_signed` with the correct seeds + bump

## CPI (Cross-Program Invocation)

- Use Pinocchio's CPI helpers, not Anchor's `CpiContext`
- Build instruction data manually for target programs (e.g., SPL Token transfer)
- Pass accounts in the exact order expected by the target program
- Always verify the target program ID before invoking

## IDL and Client Generation

- Use **Shank** attributes (`#[derive(ShankInstruction)]`, `#[derive(ShankAccount)]`) for IDL generation
- Generate TypeScript client with **Codama** from the Shank IDL
- Keep Shank attributes in sync with actual instruction/account layouts

## ZK Integration

- ZK proofs (Groth16) are generated off-chain and verified on-chain
- Proof verification instructions should validate the proof against public inputs
- Use Poseidon hashing for Merkle tree commitments (ZK-friendly)
- The deck commitment is stored on-chain; the full deck is revealed progressively

## Token Economics

- `$FLIP` is an SPL Token — use SPL Token program CPIs for mint, transfer, burn
- Stake-to-play: transfer tokens to a PDA-controlled escrow account
- Burn-for-power: invoke SPL Token burn instruction via CPI

## Testing

- Use **LiteSVM** for fast local testing (no validator needed)
- Test all account validation paths (wrong owner, missing signer, wrong PDA)
- Test instruction routing and deserialization edge cases

## Security Considerations

- Check arithmetic for overflow (use `checked_add`, `checked_sub`, `checked_mul`)
- Validate all account constraints before any state mutation
- Ensure PDAs cannot collide across different game states
- Never trust client-provided data without validation
- Log sparingly on-chain (compute budget)
