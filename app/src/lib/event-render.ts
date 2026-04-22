/**
 * Render a `GameEvent` (parsed from the program's `pushflip:*` log lines)
 * into human-readable feed text. Kind-specific — the parser keeps fields
 * as raw strings and this module owns the display semantics.
 *
 * Pubkey fields are 64-char lowercase hex from `HexPubkey` on-chain; we
 * round-trip them through Kit's `getAddressDecoder` to get canonical
 * base58 before truncating. Stake / pot / amount fields are `u64` base
 * units (`10^9` per whole $FLIP); `formatFlip` handles the scale.
 */

import { type GameEvent, type GameEventKind, parseU64 } from "@pushflip/client";
import { type Address, getAddressDecoder } from "@solana/kit";

import { formatFlip } from "./flip-format";

const addressDecoder = getAddressDecoder();

// Case-insensitive as a defensive measure — the program's `HexPubkey`
// emits lowercase and that's what we expect, but `/i` costs nothing and
// defends against a future format drift on the program side.
const HEX_PAIR_RE = /[0-9a-f]{2}/gi;

/**
 * Convert a 64-char lowercase hex pubkey (as emitted by `HexPubkey` on
 * chain) to a canonical base58 `Address`. Throws if the input is not
 * exactly 64 hex chars — the program's format guarantee means malformed
 * input is a bug, not a runtime recovery case.
 */
export function hexPubkeyToAddress(hex: string): Address {
  if (hex.length !== 64) {
    throw new Error(`expected 64-char hex pubkey, got ${hex.length}`);
  }
  const matches = hex.match(HEX_PAIR_RE);
  if (matches === null || matches.length !== 32) {
    throw new Error(`invalid hex pubkey: ${hex}`);
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const pair = matches[i];
    if (pair === undefined) {
      throw new Error(`invalid hex pubkey: ${hex}`);
    }
    bytes[i] = Number.parseInt(pair, 16);
  }
  return addressDecoder.decode(bytes);
}

/**
 * Truncate a base58 address to `4…4` for compact display.
 * Kept in lockstep with the `shortAddress` copies in game-board.tsx,
 * turn-indicator.tsx, and wallet-button.tsx.
 */
export function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function shortHexPubkey(hex: string): string {
  try {
    return shortAddress(hexPubkeyToAddress(hex));
  } catch {
    // Fall back to truncating the hex itself if the decoder choked —
    // better to show *something* in the feed than blow up the row.
    return `${hex.slice(0, 4)}…${hex.slice(-4)}`;
  }
}

/**
 * Format a `u64` base-unit decimal string (from a log line) as human
 * `$FLIP`. Route through `parseU64` rather than raw `BigInt()` per
 * Lesson #42 — BigInt silently accepts decimals / scientific notation
 * / negatives that would slip past and round-trip as a garbage u64.
 * The log format is trusted today, but using the shared validator keeps
 * the rule "no raw BigInt() on external strings" uniform across the
 * workspace (frontend, scripts, faucet).
 */
function formatStake(baseUnits: string, fieldName: string): string {
  try {
    return `${formatFlip(parseU64(baseUnits, fieldName))} $FLIP`;
  } catch {
    return `${baseUnits} (raw)`;
  }
}

function readBool(value: string | undefined): boolean {
  return value === "true";
}

/**
 * Read a required field. The parser guarantees the key set per kind
 * matches the on-chain format string — if one is missing it's either a
 * log-line truncation we couldn't detect or a program-side format change
 * we haven't caught up to. "?" keeps the feed rendering instead of
 * blowing up the whole row.
 */
function req(f: Readonly<Record<string, string>>, key: string): string {
  return f[key] ?? "?";
}

/**
 * Map each kind to a human-readable sentence.
 */
export function renderEventMessage(event: GameEvent): string {
  const f = event.fields;
  switch (event.kind) {
    case "initialize":
      return `Game ${req(f, "game_id")} initialized by ${shortHexPubkey(req(f, "authority"))} · fee ${req(f, "fee_bps")} bps`;
    case "init_vault":
      return `Vault created for game ${req(f, "game_id")}`;
    case "join_round": {
      const count = req(f, "player_count");
      return `${shortHexPubkey(req(f, "player"))} joined · stake ${formatStake(req(f, "stake"), "stake")} · ${count} player${count === "1" ? "" : "s"}`;
    }
    case "commit_deck":
      return `Dealer committed the shuffled deck for round ${req(f, "round")}`;
    case "start_round": {
      const count = req(f, "player_count");
      return `Round ${req(f, "round")} started · ${count} player${count === "1" ? "" : "s"}`;
    }
    case "hit": {
      const bust = readBool(f.bust);
      const card = `card ${req(f, "value")}/${req(f, "suit")}`;
      const who = shortHexPubkey(req(f, "player"));
      return bust ? `${who} hit — BUST on ${card}` : `${who} hit — ${card}`;
    }
    case "stay":
      return `${shortHexPubkey(req(f, "player"))} stayed · score ${req(f, "score")}`;
    case "end_round": {
      const pot = formatStake(req(f, "pot"), "pot");
      if (readBool(f.all_busted)) {
        return `Round ${req(f, "round")} ended · everyone busted · pot ${pot} to house`;
      }
      return `Round ${req(f, "round")} ended · ${shortHexPubkey(req(f, "winner"))} won ${pot}`;
    }
    case "burn_second_chance":
      return `${shortHexPubkey(req(f, "player"))} burned for a second chance`;
    case "burn_scry":
      return `${shortHexPubkey(req(f, "player"))} burned to scry · round ${req(f, "round")}`;
    case "leave_game": {
      const who = shortHexPubkey(req(f, "player"));
      return readBool(f.mid_round)
        ? `${who} left mid-round`
        : `${who} left the game`;
    }
    case "close_game":
      return `Game ${req(f, "game_id")} closed`;
    case "init_bounty_board":
      return `Bounty board created for game ${req(f, "game_id")}`;
    case "add_bounty":
      return `Bounty #${req(f, "index")} added · type ${req(f, "bounty_type")} · ${formatStake(req(f, "amount"), "amount")}`;
    case "claim_bounty":
      return `${shortHexPubkey(req(f, "claimer"))} claimed bounty #${req(f, "index")} · ${formatStake(req(f, "amount"), "amount")}`;
    case "close_bounty_board":
      return `Bounty board closed for game ${req(f, "game_id")}`;
    default: {
      // Exhaustiveness check — `event.kind` is `GameEventKind` so the
      // switch above must cover every variant. If a new kind is added
      // to the client without a case here, this line becomes a type
      // error at `never` assignment.
      const _exhaustive: never = event.kind;
      return _exhaustive;
    }
  }
}

/**
 * Explorer URL for a transaction signature. Cluster is hardcoded to
 * devnet — matches the rest of the app (see app/src/lib/constants.ts).
 * If we ever ship a mainnet build, this should read from a build-time
 * constant the same way `RPC_ENDPOINT` does.
 */
export function explorerTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

/**
 * Coarse category for each kind — used by `event-feed.tsx` to pick the
 * border / text color. Keeps the palette small (8 buckets) so 16 kinds
 * don't produce a rainbow.
 */
export type GameEventCategory =
  | "admin"
  | "lifecycle"
  | "deck"
  | "join-leave"
  | "hit"
  | "stay"
  | "burn"
  | "bounty";

export const EVENT_CATEGORY: Record<GameEventKind, GameEventCategory> = {
  initialize: "admin",
  init_vault: "admin",
  close_game: "admin",
  init_bounty_board: "admin",
  close_bounty_board: "admin",
  start_round: "lifecycle",
  end_round: "lifecycle",
  commit_deck: "deck",
  join_round: "join-leave",
  leave_game: "join-leave",
  hit: "hit",
  stay: "stay",
  burn_second_chance: "burn",
  burn_scry: "burn",
  add_bounty: "bounty",
  claim_bounty: "bounty",
};
