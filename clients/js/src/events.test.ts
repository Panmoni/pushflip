import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type GameEvent,
  type GameEventKind,
  parseEventLog,
  parseTransactionEvents,
} from "./events.js";

const PUBKEY_A =
  "0101010101010101010101010101010101010101010101010101010101010101";
const PUBKEY_B =
  "0202020202020202020202020202020202020202020202020202020202020202";
const PUBKEY_C =
  "0303030303030303030303030303030303030303030303030303030303030303";
const SIGNATURE = "5aSigStub11111111111111111111111111111111111111111111111111111111";

const ctx = (overrides?: Partial<Parameters<typeof parseEventLog>[1]>) => ({
  signature: SIGNATURE,
  slot: 123_456n,
  logIndex: 0,
  blockTime: 1_718_000_000 as number | null,
  ...overrides,
});

/**
 * Golden fixtures for all 16 event kinds. Lines are captured verbatim
 * from the format strings in `program/src/instructions/` — any future
 * field rename or reorder in the program source MUST show up as a diff
 * here. This is the behavioral spec the parser is pinned to.
 */
const GOLDEN: ReadonlyArray<
  readonly [GameEventKind, string, Record<string, string>]
> = [
  [
    "initialize",
    `pushflip:initialize:authority=${PUBKEY_A}|game_id=1|fee_bps=200`,
    { authority: PUBKEY_A, game_id: "1", fee_bps: "200" },
  ],
  [
    "init_vault",
    `pushflip:init_vault:game_id=2|vault=${PUBKEY_B}`,
    { game_id: "2", vault: PUBKEY_B },
  ],
  [
    "join_round",
    `pushflip:join_round:player=${PUBKEY_A}|game_id=2|stake=100000000000|player_count=3`,
    {
      player: PUBKEY_A,
      game_id: "2",
      stake: "100000000000",
      player_count: "3",
    },
  ],
  [
    "commit_deck",
    `pushflip:commit_deck:game_id=2|round=1|merkle_root=${PUBKEY_C}`,
    { game_id: "2", round: "1", merkle_root: PUBKEY_C },
  ],
  [
    "start_round",
    "pushflip:start_round:game_id=2|round=1|player_count=3",
    { game_id: "2", round: "1", player_count: "3" },
  ],
  [
    "hit",
    `pushflip:hit:player=${PUBKEY_A}|game_id=2|round=1|card_type=0|value=7|suit=2|bust=false`,
    {
      player: PUBKEY_A,
      game_id: "2",
      round: "1",
      card_type: "0",
      value: "7",
      suit: "2",
      bust: "false",
    },
  ],
  [
    "stay",
    `pushflip:stay:player=${PUBKEY_A}|game_id=2|round=1|score=18`,
    { player: PUBKEY_A, game_id: "2", round: "1", score: "18" },
  ],
  [
    "end_round",
    `pushflip:end_round:game_id=2|round=1|winner=${PUBKEY_A}|pot=400000000000|all_busted=false`,
    {
      game_id: "2",
      round: "1",
      winner: PUBKEY_A,
      pot: "400000000000",
      all_busted: "false",
    },
  ],
  [
    "burn_second_chance",
    `pushflip:burn_second_chance:player=${PUBKEY_A}|game_id=2`,
    { player: PUBKEY_A, game_id: "2" },
  ],
  [
    "burn_scry",
    `pushflip:burn_scry:player=${PUBKEY_A}|game_id=2|round=1`,
    { player: PUBKEY_A, game_id: "2", round: "1" },
  ],
  [
    "leave_game",
    `pushflip:leave_game:player=${PUBKEY_A}|game_id=2|mid_round=true`,
    { player: PUBKEY_A, game_id: "2", mid_round: "true" },
  ],
  [
    "close_game",
    "pushflip:close_game:game_id=2",
    { game_id: "2" },
  ],
  [
    "init_bounty_board",
    `pushflip:init_bounty_board:game_id=2|board=${PUBKEY_B}`,
    { game_id: "2", board: PUBKEY_B },
  ],
  [
    "add_bounty",
    "pushflip:add_bounty:game_id=2|index=0|bounty_type=1|amount=50000000000",
    { game_id: "2", index: "0", bounty_type: "1", amount: "50000000000" },
  ],
  [
    "claim_bounty",
    `pushflip:claim_bounty:claimer=${PUBKEY_A}|game_id=2|index=0|bounty_type=1|amount=50000000000`,
    {
      claimer: PUBKEY_A,
      game_id: "2",
      index: "0",
      bounty_type: "1",
      amount: "50000000000",
    },
  ],
  [
    "close_bounty_board",
    "pushflip:close_bounty_board:game_id=2",
    { game_id: "2" },
  ],
];

describe("parseEventLog — golden fixtures", () => {
  for (const [kind, line, expectedFields] of GOLDEN) {
    it(`parses ${kind}`, () => {
      const ev = parseEventLog(line, ctx());
      assert.ok(ev, `expected ${kind} to parse`);
      assert.equal(ev.kind, kind);
      assert.deepEqual(ev.fields, expectedFields);
      assert.equal(ev.id, `${SIGNATURE}:0`);
      assert.equal(ev.signature, SIGNATURE);
      assert.equal(ev.slot, 123_456n);
      assert.equal(ev.logIndex, 0);
      assert.equal(ev.blockTime, 1_718_000_000);
    });

    it(`parses ${kind} with the "Program log: " prefix`, () => {
      const ev = parseEventLog(`Program log: ${line}`, ctx());
      assert.ok(ev);
      assert.equal(ev.kind, kind);
      assert.deepEqual(ev.fields, expectedFields);
    });
  }
});

describe("parseEventLog — rejects non-events", () => {
  it("returns null for a non-pushflip program-log line", () => {
    assert.equal(
      parseEventLog("Program log: Instruction: Transfer", ctx()),
      null
    );
  });

  it("returns null for a Solana-runtime line", () => {
    assert.equal(
      parseEventLog(
        "Program HQLeAQc84WLz8buHM5JAJGBjNJjwc6Fpxts8jSMaW3px success",
        ctx()
      ),
      null
    );
  });

  it("returns null for an unknown pushflip kind", () => {
    assert.equal(
      parseEventLog("pushflip:unknown_kind:x=1", ctx()),
      null
    );
  });

  it("returns null for a truncated line with no colon after the kind", () => {
    assert.equal(parseEventLog("pushflip:hit", ctx()), null);
  });

  it("returns null for an empty line", () => {
    assert.equal(parseEventLog("", ctx()), null);
  });

  it("returns null for a malformed field segment (no '=')", () => {
    assert.equal(
      parseEventLog("pushflip:stay:player=abc|bare_token", ctx()),
      null
    );
  });

  it("returns null for a segment with '=' at position 0 (empty key)", () => {
    assert.equal(
      parseEventLog("pushflip:stay:=value_without_key", ctx()),
      null
    );
  });

  it("accepts a kind with no fields (empty tail after the kind colon)", () => {
    // Not a shape the program actually emits today — production
    // close_game is "pushflip:close_game:game_id=N" — but if a future
    // kind ever has zero fields, the parser shouldn't choke. `fields`
    // is an empty object, the rest of the envelope still validates.
    const ev = parseEventLog("pushflip:close_game:", ctx());
    assert.ok(ev);
    assert.equal(ev.kind, "close_game");
    assert.deepEqual(ev.fields, {});
  });
});

describe("parseEventLog — id composition", () => {
  it("uses signature + logIndex to form a stable id", () => {
    const a = parseEventLog("pushflip:close_game:game_id=1", ctx({ logIndex: 3 }));
    const b = parseEventLog("pushflip:close_game:game_id=1", ctx({ logIndex: 3 }));
    assert.ok(a);
    assert.ok(b);
    assert.equal(a.id, b.id);
    assert.equal(a.id, `${SIGNATURE}:3`);
  });

  it("distinguishes two events in the same tx by logIndex", () => {
    const a = parseEventLog(
      "pushflip:close_game:game_id=1",
      ctx({ logIndex: 3 })
    );
    const b = parseEventLog(
      "pushflip:close_game:game_id=1",
      ctx({ logIndex: 9 })
    );
    assert.ok(a);
    assert.ok(b);
    assert.notEqual(a.id, b.id);
  });
});

describe("parseTransactionEvents", () => {
  it("extracts only pushflip lines from a mixed log array", () => {
    const logs = [
      "Program HQLeAQc84WLz8buHM5JAJGBjNJjwc6Fpxts8jSMaW3px invoke [1]",
      "Program log: Instruction: JoinRound",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]",
      "Program log: Instruction: Transfer",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success",
      `Program log: pushflip:join_round:player=${PUBKEY_A}|game_id=2|stake=100000000000|player_count=3`,
      "Program HQLeAQc84WLz8buHM5JAJGBjNJjwc6Fpxts8jSMaW3px consumed 42000 of 200000 compute units",
      "Program HQLeAQc84WLz8buHM5JAJGBjNJjwc6Fpxts8jSMaW3px success",
    ];
    const events = parseTransactionEvents(
      SIGNATURE,
      500n,
      1_718_000_000,
      logs
    );
    assert.equal(events.length, 1);
    const [ev] = events as [GameEvent];
    assert.equal(ev.kind, "join_round");
    // logIndex is the position in the FULL logs array (not among pushflip
    // matches), so the id stays stable if future program changes add or
    // remove surrounding CPI lines around our emission.
    assert.equal(ev.logIndex, 5);
    assert.equal(ev.id, `${SIGNATURE}:5`);
    assert.equal(ev.slot, 500n);
    assert.equal(ev.blockTime, 1_718_000_000);
  });

  it("returns an empty array when no pushflip lines are present", () => {
    const events = parseTransactionEvents(SIGNATURE, 500n, null, [
      "Program log: Instruction: Transfer",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success",
    ]);
    assert.equal(events.length, 0);
  });

  it("handles two pushflip events in the same tx (future batched-ix case)", () => {
    // Today the program emits exactly one pushflip line per instruction.
    // The parser must still give distinct ids if two ever share a tx,
    // because logIndex differs.
    const logs = [
      `Program log: pushflip:start_round:game_id=2|round=1|player_count=3`,
      `Program log: pushflip:hit:player=${PUBKEY_A}|game_id=2|round=1|card_type=0|value=7|suit=2|bust=false`,
    ];
    const events = parseTransactionEvents(SIGNATURE, 500n, null, logs);
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, "start_round");
    assert.equal(events[1].kind, "hit");
    assert.notEqual(events[0].id, events[1].id);
  });

  it("carries blockTime=null through when the source does not have it (logsNotifications)", () => {
    const events = parseTransactionEvents(SIGNATURE, 500n, null, [
      "Program log: pushflip:close_game:game_id=2",
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0].blockTime, null);
  });
});
