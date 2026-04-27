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

import { truncateAddress } from "./address-format";
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
 * Resolve a 64-char hex pubkey to a Kit `Address` (base58). Returns
 * `null` if the hex is malformed — callers render a literal "?" or
 * a fallback string so a single bad log line doesn't blow up the row.
 */
function hexPubkeyToAddressOrNull(hex: string): Address | null {
  try {
    return hexPubkeyToAddress(hex);
  } catch {
    return null;
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
 * One token of a rendered event message.
 *
 * - `string`: a literal sentence fragment (already formatted).
 * - `{ kind: "address", address }`: a wallet address that should be
 *   rendered as its registered nickname (or fallback) by the consumer.
 *
 * Pre-Mainnet 5.0.10 — separates the renderer from address resolution
 * so the feed can swap truncated `4…4` for `<DisplayName>` JSX
 * without coupling event-render to React Query / faucet plumbing.
 */
export type EventToken = string | { kind: "address"; address: Address };

/**
 * Resolve a hex pubkey field to an EventToken: either an `address`
 * token (when the hex parses cleanly) or a literal "?" string (when
 * malformed — better than blowing up the row).
 */
function addressToken(hex: string): EventToken {
  const addr = hexPubkeyToAddressOrNull(hex);
  return addr === null ? "?" : { kind: "address", address: addr };
}

/**
 * Map each kind to a sequence of tokens. Consumers (event-feed.tsx)
 * walk the array and render strings as text + address tokens as
 * `<DisplayName>` JSX.
 *
 * Tokens are joined visually with no extra separator — the strings
 * carry their own whitespace.
 *
 * **Invariant (load-bearing for `event-feed.tsx`'s React keys)**: each
 * kind's token list must contain **at most one** address token. The
 * consumer keys address tokens by `a:${address}`; two address tokens
 * with the same pubkey in one event would produce duplicate React
 * keys. The current 17 kinds satisfy this, and the test
 * `event-render-tokens.test.ts` walks the full kind set to enforce it
 * mechanically — adding a new kind that mentions two pubkeys breaks
 * the test, forcing the author to disambiguate (e.g., `a:winner:…` /
 * `a:loser:…`) before merging.
 */
export function renderEventTokens(event: GameEvent): EventToken[] {
  const f = event.fields;
  switch (event.kind) {
    case "initialize":
      return [
        `Game ${req(f, "game_id")} initialized by `,
        addressToken(req(f, "authority")),
        ` · fee ${req(f, "fee_bps")} bps`,
      ];
    case "init_vault":
      return [`Vault created for game ${req(f, "game_id")}`];
    case "join_round": {
      const count = req(f, "player_count");
      return [
        addressToken(req(f, "player")),
        ` joined · stake ${formatStake(req(f, "stake"), "stake")} · ${count} player${count === "1" ? "" : "s"}`,
      ];
    }
    case "commit_deck":
      return [
        `Dealer committed the shuffled deck for round ${req(f, "round")}`,
      ];
    case "start_round": {
      const count = req(f, "player_count");
      return [
        `Round ${req(f, "round")} started · ${count} player${count === "1" ? "" : "s"}`,
      ];
    }
    case "hit": {
      const bust = readBool(f.bust);
      const card = `card ${req(f, "value")}/${req(f, "suit")}`;
      return [
        addressToken(req(f, "player")),
        bust ? ` hit — BUST on ${card}` : ` hit — ${card}`,
      ];
    }
    case "stay":
      return [
        addressToken(req(f, "player")),
        ` stayed · score ${req(f, "score")}`,
      ];
    case "end_round": {
      const pot = formatStake(req(f, "pot"), "pot");
      if (readBool(f.all_busted)) {
        return [
          `Round ${req(f, "round")} ended · everyone busted · pot ${pot} to house`,
        ];
      }
      return [
        `Round ${req(f, "round")} ended · `,
        addressToken(req(f, "winner")),
        ` won ${pot}`,
      ];
    }
    case "burn_second_chance":
      return [addressToken(req(f, "player")), " burned for a second chance"];
    case "burn_scry":
      return [
        addressToken(req(f, "player")),
        ` burned to scry · round ${req(f, "round")}`,
      ];
    case "leave_game": {
      return [
        addressToken(req(f, "player")),
        readBool(f.mid_round) ? " left mid-round" : " left the game",
      ];
    }
    case "close_game":
      return [`Game ${req(f, "game_id")} closed`];
    case "init_bounty_board":
      return [`Bounty board created for game ${req(f, "game_id")}`];
    case "add_bounty":
      return [
        `Bounty #${req(f, "index")} added · type ${req(f, "bounty_type")} · ${formatStake(req(f, "amount"), "amount")}`,
      ];
    case "claim_bounty":
      return [
        addressToken(req(f, "claimer")),
        ` claimed bounty #${req(f, "index")} · ${formatStake(req(f, "amount"), "amount")}`,
      ];
    case "close_bounty_board":
      return [`Bounty board closed for game ${req(f, "game_id")}`];
    default: {
      // Exhaustiveness check — `event.kind` is `GameEventKind` so the
      // switch above must cover every variant. If a new kind is added
      // to the client without a case here, this line becomes a type
      // error at `never` assignment.
      const _exhaustive: never = event.kind;
      return [_exhaustive];
    }
  }
}

/**
 * Plain-text variant of the renderer for contexts that can't render
 * JSX (e.g. sonner toasts fired outside the React tree). Converts
 * address tokens to truncated `4…4` form. The tokenizer is the source
 * of truth for the message; this function just collapses it.
 */
export function renderEventMessageText(event: GameEvent): string {
  return renderEventTokens(event)
    .map((tok) =>
      typeof tok === "string" ? tok : truncateAddress(tok.address.toString())
    )
    .join("");
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
