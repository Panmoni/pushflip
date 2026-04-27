/**
 * Invariant tests for `event-render.ts` token output.
 *
 * Run via `pnpm --filter @pushflip/app test` (Node's built-in test
 * runner via tsx, matching the convention used by `clients/js`).
 *
 * The most important thing this test enforces is the
 * "≤ 1 address token per kind" invariant — the consumer
 * (`event-feed.tsx`) keys address tokens by content (`a:${address}`)
 * to satisfy biome's `noArrayIndexKey` rule, which is only safe if no
 * single event ever produces two address tokens with the same pubkey.
 * The current 17 kinds satisfy this; if a future kind references two
 * pubkeys (e.g., a "transfer-from-A-to-B" event), this test fails and
 * forces the author to disambiguate before merging.
 */

import { equal, ok } from "node:assert/strict";
import { describe, it } from "node:test";

import type { GameEvent, GameEventKind } from "@pushflip/client";
import type { Signature } from "@solana/kit";

import { type EventToken, renderEventTokens } from "./event-render";

const ALL_KINDS: GameEventKind[] = [
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
];

// Plausible 64-char lowercase-hex pubkey. The renderer round-trips
// it through Kit's address decoder, so it must decode cleanly to 32
// bytes. Any 64 hex chars work.
const HEX_A = "1".repeat(64);

/**
 * Build a synthetic `GameEvent` of the given kind, populating every
 * field the renderer might read with placeholder values that satisfy
 * the format guards (decimal strings for u64, "true"/"false" for
 * bools, 64-char hex for pubkeys).
 */
function fakeEvent(kind: GameEventKind): GameEvent {
  const fields: Record<string, string> = {
    game_id: "1",
    round: "0",
    player_count: "2",
    fee_bps: "100",
    authority: HEX_A,
    player: HEX_A,
    winner: HEX_A,
    claimer: HEX_A,
    stake: "1000000000",
    pot: "5000000000",
    amount: "100000000",
    score: "21",
    value: "10",
    suit: "1",
    bust: "false",
    all_busted: "false",
    mid_round: "false",
    bounty_type: "1",
    index: "0",
  };
  return {
    id: `synthetic:${kind}`,
    kind,
    fields,
    signature: "deadbeef" as Signature,
    slot: 1n,
    blockTime: 0,
    logIndex: 0,
  } as unknown as GameEvent;
}

/**
 * Variant of `fakeEvent` that lets a test override specific field
 * values. Necessary because `GameEvent.fields` is typed as
 * `Readonly<Record<string, string>>` — direct mutation isn't allowed.
 */
function fakeEventWithFieldOverride(
  kind: GameEventKind,
  override: Record<string, string>
): GameEvent {
  const base = fakeEvent(kind);
  return {
    ...base,
    fields: { ...base.fields, ...override },
  } as GameEvent;
}

describe("renderEventTokens — ≤ 1 address per kind invariant", () => {
  it("every kind produces at most one address token", () => {
    for (const kind of ALL_KINDS) {
      const tokens = renderEventTokens(fakeEvent(kind));
      const addressTokens = tokens.filter(
        (t): t is Extract<EventToken, { kind: "address" }> =>
          typeof t !== "string"
      );
      ok(
        addressTokens.length <= 1,
        `kind "${kind}" produced ${addressTokens.length} address tokens — keys would collide in EventMessage. Disambiguate or update tokenKey().`
      );
    }
  });

  it("kinds that mention a player return exactly one address token", () => {
    const playerKinds: GameEventKind[] = [
      "join_round",
      "hit",
      "stay",
      "burn_second_chance",
      "burn_scry",
      "leave_game",
      "claim_bounty",
    ];
    for (const kind of playerKinds) {
      const tokens = renderEventTokens(fakeEvent(kind));
      const addressTokens = tokens.filter((t) => typeof t !== "string");
      equal(
        addressTokens.length,
        1,
        `kind "${kind}" expected to render exactly one address token`
      );
    }
  });

  it("kinds without a wallet field return zero address tokens", () => {
    const noWalletKinds: GameEventKind[] = [
      "init_vault",
      "commit_deck",
      "start_round",
      "close_game",
      "init_bounty_board",
      "add_bounty",
      "close_bounty_board",
    ];
    for (const kind of noWalletKinds) {
      const tokens = renderEventTokens(fakeEvent(kind));
      const addressTokens = tokens.filter((t) => typeof t !== "string");
      equal(
        addressTokens.length,
        0,
        `kind "${kind}" should not emit address tokens`
      );
    }
  });

  it("end_round renders an address only on the winner branch", () => {
    const winnerEv = fakeEvent("end_round");
    const winnerTokens = renderEventTokens(winnerEv);
    equal(winnerTokens.filter((t) => typeof t !== "string").length, 1);

    const allBustedEv = fakeEventWithFieldOverride("end_round", {
      all_busted: "true",
    });
    const allBustedTokens = renderEventTokens(allBustedEv);
    equal(allBustedTokens.filter((t) => typeof t !== "string").length, 0);
  });

  it("malformed hex pubkeys fall back to a literal '?' string", () => {
    const ev = fakeEventWithFieldOverride("hit", {
      player: "not-actually-hex",
    });
    const tokens = renderEventTokens(ev);
    // Renderer should not throw; the address slot becomes the
    // literal "?" string token.
    ok(tokens.some((t) => t === "?"));
  });
});
