//! Structured event-log helpers for the pushflip program.
//!
//! ## Why this exists
//!
//! The on-chain program is the single source of truth for what happened
//! in a game. We emit a structured log line on the successful tail of
//! every state-changing instruction so any client — the React frontend,
//! an offline indexer, a second device, the House AI in Phase 4 —
//! can reconstruct the full event history from [`logsNotifications`] +
//! [`getSignaturesForAddress`] without relying on stateful client
//! subscriptions (which the frontend tried first, via state-diffs, and
//! found inadequate — see Pre-Mainnet 5.0.9 in `docs/EXECUTION_PLAN.md`).
//!
//! ## Event format
//!
//! ```text
//! pushflip:<kind>:<k1>=<v1>|<k2>=<v2>|...
//! ```
//!
//! - **Kinds**: one per state-changing instruction (16 total). Consumers
//!   key off `<kind>`.
//! - **Values**: `u8`/`u16`/`u64` as decimal strings, `bool` as
//!   `true`/`false`, `Pubkey` (i.e. the 32-byte on-chain representation)
//!   as **64-char lowercase hex** via the [`HexPubkey`] newtype. Hex
//!   over base58 was a deliberate choice: base58 encoding on-chain
//!   would need a `five8`-style crate (~45 KB binary cost + thousands
//!   of CU per pubkey). Hex is zero-CU (just nibble extraction + ASCII
//!   table lookup), zero binary cost, and trivial to re-encode as
//!   base58 on the client.
//!
//! ## Byte budget
//!
//! `pinocchio-log`'s internal buffer defaults to 200 bytes. The
//! Solana runtime prepends `"Program log: "` (13 bytes) BEFORE our
//! message, but that's outside our 200-byte budget. We have the full
//! 200 for our payload.
//!
//! The worst-case `end_round` line with all fields at u64::MAX plus a
//! 64-char hex winner pubkey clocks in at ~172 bytes. Every event
//! defined in this project fits comfortably in one log call — no
//! splitting needed.
//!
//! ## Failure semantics
//!
//! Event calls live at the successful TAIL of each instruction handler,
//! AFTER all state mutations and BEFORE the final `Ok(())`. If the
//! instruction errors earlier, Solana's runtime reverts the state AND
//! the log is never emitted. Logs from failed transactions DO appear
//! in `meta.logMessages` but are accompanied by a non-null `meta.err`;
//! consumers are expected to skip those txs entirely. Since we only
//! emit on the success path, a failed tx never contains a
//! `pushflip:*` line, and this design is robust against partial-handler
//! failure modes.
//!
//! ## Emitting events
//!
//! We considered writing a thin `event!` wrapper macro around
//! [`pinocchio_log::log!`] that prepends `pushflip:<kind>:`, but ran
//! into a fundamental limitation: `pinocchio-log`'s `log!` proc-macro
//! parses its format string as a `LitStr` at the token level, and
//! `concat!(…)` produces a `Macro` AST node (not a literal) — so any
//! `macro_rules!` wrapper that used `concat!` to inject the `pushflip:`
//! prefix failed to compile with `expected string literal`. Rather
//! than hide the prefix behind a custom proc-macro (extra crate,
//! extra compile time, extra failure surface), we inline the full
//! prefix at each call site.
//!
//! Every event-emitting call in the program looks like this:
//!
//! ```ignore
//! pinocchio_log::log!(
//!     "pushflip:<kind>:field1={}|field2={}|...",
//!     arg1, arg2, ...
//! );
//! ```
//!
//! - The `pushflip:<kind>:` prefix is mandatory and MUST start the
//!   literal. Consumers pattern-match on `^Program log: pushflip:`
//!   to filter our events out of the interleaved log stream.
//! - Use `{}` placeholders for values. Supported types are
//!   `u8`/`u16`/`u32`/`u64`/`usize`, their signed variants, `bool`,
//!   `&str`, and [`HexPubkey`] for 32-byte on-chain pubkeys.
//! - Keep each line under 200 bytes. A single event should never
//!   need more than one `log!` call.
//!
//! ## Adding a new event
//!
//! 1. Add the `pinocchio_log::log!` call at the tail of the new
//!    instruction handler (see existing handlers for the pattern).
//! 2. Verify the worst-case serialized line fits under 200 bytes. The
//!    [`HexPubkey`] newtype always emits exactly 64 hex chars; u64
//!    values are at most 20 chars; u8 at most 3; bool at most 5.
//! 3. Add a matching `GameEventKind` entry and a golden-fixture test
//!    case in `clients/js/src/events.ts` + `events.test.ts` (PR 2).

use core::mem::MaybeUninit;

use pinocchio_log::logger::{Argument, Log};

/// Newtype that formats a 32-byte on-chain pubkey as 64 lowercase hex
/// characters when written through `pinocchio-log`'s `Logger`. Wraps a
/// borrowed reference so there's no copying and no heap allocation.
///
/// Usage inline with `pinocchio_log::log!` (no wrapper macro — see the
/// module-level doc for why a `concat!`-based wrapper can't work):
///
/// ```ignore
/// pinocchio_log::log!(
///     "pushflip:join_round:player={}|game_id={}",
///     HexPubkey(player.address().as_array()),
///     game_id,
/// );
/// ```
///
/// ## Why hex instead of base58
///
/// `pinocchio-log` has no `Log` impl for pubkey-shaped byte arrays, so
/// we would have to either (a) add a base58 dep like `five8` (~45 KB
/// binary + ~5 KB CU per encode) or (b) write our own hex formatter
/// (what we do here — zero deps, zero CU overhead). The 20-byte-per-
/// pubkey bloat on the wire (64-char hex vs ~44-char base58) is
/// negligible against our 200-byte budget, and the frontend converts
/// hex to base58 for display in one line of TS.
pub struct HexPubkey<'a>(pub &'a [u8; 32]);

/// SAFETY: `write_with_args` writes exactly `min(64, buffer.len())`
/// bytes of initialized hex characters and returns that count. Never
/// reads past `self.0[31]`. Never writes past `buffer.len()`.
unsafe impl<'a> Log for HexPubkey<'a> {
    fn write_with_args(&self, buffer: &mut [MaybeUninit<u8>], _args: &[Argument]) -> usize {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut written = 0usize;
        for &byte in self.0 {
            if written + 2 > buffer.len() {
                break;
            }
            // SAFETY: bounds checked above.
            unsafe {
                buffer
                    .get_unchecked_mut(written)
                    .write(HEX[(byte >> 4) as usize]);
                buffer
                    .get_unchecked_mut(written + 1)
                    .write(HEX[(byte & 0x0F) as usize]);
            }
            written += 2;
        }
        written
    }
}
