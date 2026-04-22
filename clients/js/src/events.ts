/**
 * Event log parsing for the `pushflip:<kind>:k=v|k=v|...` lines the program
 * emits at the tail of every state-changing instruction (Pre-Mainnet 5.0.9
 * PR 1, deployed 2026-04-15).
 *
 * Framework-agnostic and pure — no React, no Kit RPC calls, no `@solana/kit`
 * imports. The app pairs this with `getSignaturesForAddress` +
 * `getTransaction` (historical backfill) and `logsNotifications` (live) to
 * build an authoritative event feed that survives refresh and cross-device.
 *
 * Field values are left as raw strings. Pubkeys are 64-char lowercase hex
 * (`HexPubkey` in the program) — the frontend's renderer converts them to
 * base58 via `getAddressDecoder`. Booleans are `"true"` / `"false"`.
 * Integers are unsigned decimal strings (`u8` / `u16` / `u64`). Callers
 * coerce per-kind when they know the schema.
 */

const EVENT_LINE_PREFIX = "pushflip:";
const PROGRAM_LOG_PREFIX = "Program log: ";

/**
 * The 16 state-changing instructions that emit events. 1:1 with
 * `program/src/instructions/`. Ordered to match the on-chain dispatcher
 * so diffs against the program source are obvious.
 */
export type GameEventKind =
  | "initialize"
  | "init_vault"
  | "join_round"
  | "commit_deck"
  | "start_round"
  | "hit"
  | "stay"
  | "end_round"
  | "burn_second_chance"
  | "burn_scry"
  | "leave_game"
  | "close_game"
  | "init_bounty_board"
  | "add_bounty"
  | "claim_bounty"
  | "close_bounty_board";

const KNOWN_KINDS: ReadonlySet<string> = new Set<GameEventKind>([
  "initialize",
  "init_vault",
  "join_round",
  "commit_deck",
  "start_round",
  "hit",
  "stay",
  "end_round",
  "burn_second_chance",
  "burn_scry",
  "leave_game",
  "close_game",
  "init_bounty_board",
  "add_bounty",
  "claim_bounty",
  "close_bounty_board",
]);

export interface GameEvent {
  /**
   * Unique id `${signature}:${logIndex}` where `logIndex` is the index
   * within the transaction's full `meta.logMessages` array (not within
   * the filtered pushflip subset). Stable across refresh and across
   * devices — same signature + same log line position yields the same
   * id everywhere.
   */
  id: string;
  kind: GameEventKind;
  /**
   * Raw `key=value` fields from the log line. Values are NOT coerced —
   * `"stake"` is still a decimal string, `"player"` is still 64-char
   * lowercase hex, `"bust"` is still `"true"` / `"false"`. Coercion is
   * the renderer's job (it's kind-specific and belongs next to the
   * display strings).
   */
  fields: Readonly<Record<string, string>>;
  signature: string;
  slot: bigint;
  logIndex: number;
  /**
   * Unix seconds, best-effort. Carries the node's `blockTime` for
   * backfilled events (authoritative) and the client's wall-clock-on-
   * arrival for live events (approximation — the `logsNotifications`
   * payload does NOT include blockTime). Consumers that need chain
   * truth should check `slot` instead; consumers that just want a
   * feed timestamp can read this directly. `null` is reserved for the
   * rare case where the node returns a tx without blockTime (old /
   * pruned blocks).
   */
  blockTime: number | null;
}

export interface ParseEventLogContext {
  signature: string;
  slot: bigint;
  logIndex: number;
  blockTime: number | null;
}

/**
 * Parse a single log line into a `GameEvent`, or `null` if the line is
 * not a pushflip event (CPI logs, SPL-token interleaved logs, runtime
 * "Program <id> success" lines, unknown pushflip kinds, malformed k=v
 * pairs). Accepts both the raw `"Program log: pushflip:..."` form as it
 * appears in `meta.logMessages` AND the already-stripped `"pushflip:..."`
 * form — the caller doesn't need to know which.
 */
export function parseEventLog(
  line: string,
  ctx: ParseEventLogContext
): GameEvent | null {
  const stripped = line.startsWith(PROGRAM_LOG_PREFIX)
    ? line.slice(PROGRAM_LOG_PREFIX.length)
    : line;

  if (!stripped.startsWith(EVENT_LINE_PREFIX)) {
    return null;
  }

  const afterPrefix = stripped.slice(EVENT_LINE_PREFIX.length);
  const firstColon = afterPrefix.indexOf(":");
  if (firstColon < 0) {
    return null;
  }

  const kind = afterPrefix.slice(0, firstColon);
  if (!KNOWN_KINDS.has(kind)) {
    return null;
  }

  const rest = afterPrefix.slice(firstColon + 1);
  const fields = parseFields(rest);
  if (fields === null) {
    return null;
  }

  return {
    id: `${ctx.signature}:${ctx.logIndex}`,
    kind: kind as GameEventKind,
    fields,
    signature: ctx.signature,
    slot: ctx.slot,
    logIndex: ctx.logIndex,
    blockTime: ctx.blockTime,
  };
}

/**
 * Parse every pushflip line out of a transaction's `meta.logMessages`.
 * Each matching line becomes one `GameEvent`; non-matching lines (SPL
 * token CPI chatter, runtime lines, other programs) are silently skipped.
 * `logIndex` is the position in the full `logMessages` array — NOT the
 * position among pushflip events — so the id stays stable even when
 * future program changes add or remove surrounding CPI calls.
 *
 * Caller contract: `logMessages` is the raw `meta.logMessages` array
 * from `getTransaction`, or the `logs` array from `logsNotifications`.
 * Both use the same `"Program log: ..."` prefix convention, so passing
 * either form is correct.
 */
export function parseTransactionEvents(
  signature: string,
  slot: bigint,
  blockTime: number | null,
  logMessages: readonly string[]
): GameEvent[] {
  const events: GameEvent[] = [];
  for (let i = 0; i < logMessages.length; i++) {
    const line = logMessages[i];
    if (line === undefined) {
      continue;
    }
    const event = parseEventLog(line, {
      signature,
      slot,
      logIndex: i,
      blockTime,
    });
    if (event !== null) {
      events.push(event);
    }
  }
  return events;
}

/**
 * Split the `k1=v1|k2=v2|...` tail into a plain object. Returns `null`
 * if any segment is missing an `=` (treat the whole line as malformed
 * rather than returning a partial decode).
 *
 * Values may NOT contain `|` (the program uses `|` as field separator and
 * never emits it inside values — pubkeys are hex, ints are decimal,
 * bools are `true`/`false`). Keys may NOT contain `=`. Both guarantees
 * come from the program source; violating them is a parser-contract
 * break, not a runtime recovery case.
 */
function parseFields(rest: string): Record<string, string> | null {
  if (rest.length === 0) {
    return {};
  }
  const out: Record<string, string> = {};
  const segments = rest.split("|");
  for (const segment of segments) {
    const eq = segment.indexOf("=");
    if (eq <= 0) {
      return null;
    }
    const key = segment.slice(0, eq);
    const value = segment.slice(eq + 1);
    out[key] = value;
  }
  return out;
}
