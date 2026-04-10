//! Bounty board instruction handlers.
//!
//! ## Design
//!
//! The bounty board is an OPTIONAL companion PDA to a `GameSession`.
//! Authority creates it, adds bounties, and players claim them when
//! they meet the win condition. **No tokens are transferred on-chain
//! by `claim_bounty`** — the on-chain record marks the claim and stores
//! the claimer's address; the actual reward payout is the authority's
//! responsibility (off-chain or via a separate token transfer
//! instruction). This keeps the bounty board logic simple and avoids
//! requiring a second token vault.
//!
//! ## Bounty types and their on-chain win conditions
//!
//! | Type | Code | Win condition |
//! |---|---|---|
//! | `SEVEN_CARD_WIN` | 0 | `player_state.hand_size >= 7 AND inactive_reason == STAYED` |
//! | `HIGH_SCORE`     | 1 | `player_state.score >= bounty.reward_amount` (reward doubles as the threshold) |
//! | `SURVIVOR`       | 2 | `player_state.inactive_reason == STAYED` (any stayed player) |
//! | `COMEBACK`       | 3 | `player_state.has_used_second_chance == true AND inactive_reason == STAYED` |
//!
//! `HIGH_SCORE` overloads the `reward_amount` field as the score
//! threshold. This is a deliberate trade-off to keep the bounty layout
//! at 42 bytes (no schema migration required). It means HIGH_SCORE
//! bounties can't store an off-chain payout amount distinct from the
//! threshold — but as documented above, this instruction set doesn't
//! transfer tokens anyway, so the field is purely metadata for
//! off-chain readers.
//!
//! ## Instructions
//!
//! - `init_bounty_board` (discriminator 12) — create the PDA
//! - `add_bounty`        (discriminator 13) — append a bounty to the board
//! - `claim_bounty`      (discriminator 14) — player marks themselves as claimer
//! - `close_bounty_board` (discriminator 15) — refund rent to the authority

pub mod add_bounty;
pub mod claim_bounty;
pub mod close_bounty_board;
pub mod init_bounty_board;
