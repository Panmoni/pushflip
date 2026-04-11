import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AccountRole,
  type Address,
  appendTransactionMessageInstruction,
  createTransactionMessage,
  pipe,
} from "@solana/kit";

import {
  decodeBountyBoard,
  decodeGameSession,
  decodePlayerState,
} from "./index.js";
import { parseU64, U64_MAX, u64Le } from "./bytes.js";
import {
  BOUNTY_BOARD_DISCRIMINATOR,
  GAME_SESSION_DISCRIMINATOR,
  Instructions,
  MAX_PLAYERS,
  PLAYER_STATE_DISCRIMINATOR,
  PUSHFLIP_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./constants.js";
import {
  deriveBountyPda,
  deriveGamePda,
  derivePlayerPda,
  deriveVaultPda,
} from "./pda.js";
import {
  getBurnScryInstruction,
  getBurnSecondChanceInstruction,
  getCloseGameInstruction,
  getCommitDeckInstruction,
  getEndRoundInstruction,
  getHitInstruction,
  getInitializeInstruction,
  getJoinRoundInstruction,
  getLeaveGameInstruction,
  getStartRoundInstruction,
  getStayInstruction,
} from "./instructions.js";

const FAKE_ADDR_1 = "11111111111111111111111111111112" as Address;
const FAKE_ADDR_2 = "11111111111111111111111111111113" as Address;
const FAKE_ADDR_3 = "11111111111111111111111111111114" as Address;
const FAKE_ADDR_4 = "11111111111111111111111111111115" as Address;
const FAKE_ADDR_5 = "11111111111111111111111111111116" as Address;
const FAKE_ADDR_6 = "11111111111111111111111111111117" as Address;

// --- PDA derivation ---

describe("PDA derivation", () => {
  it("deriveGamePda is deterministic", async () => {
    const [pda1, bump1] = await deriveGamePda(1n);
    const [pda2, bump2] = await deriveGamePda(1n);
    assert.equal(pda1, pda2);
    assert.equal(bump1, bump2);
  });

  it("deriveGamePda differs by game_id", async () => {
    const [pda1] = await deriveGamePda(1n);
    const [pda2] = await deriveGamePda(2n);
    assert.notEqual(pda1, pda2);
  });

  it("derivePlayerPda differs by player", async () => {
    const [pda1] = await derivePlayerPda(1n, FAKE_ADDR_1);
    const [pda2] = await derivePlayerPda(1n, FAKE_ADDR_2);
    assert.notEqual(pda1, pda2);
  });

  it("deriveVaultPda is unique per game session", async () => {
    const [game1] = await deriveGamePda(1n);
    const [game2] = await deriveGamePda(2n);
    const [vault1] = await deriveVaultPda(game1);
    const [vault2] = await deriveVaultPda(game2);
    assert.notEqual(vault1, vault2);
  });

  it("deriveBountyPda is unique per game session", async () => {
    const [game] = await deriveGamePda(42n);
    const [bounty] = await deriveBountyPda(game);
    assert.notEqual(bounty, game);
  });
});

// --- Instruction encoding ---

describe("Instruction builders", () => {
  it("getInitializeInstruction encodes data and accounts correctly", () => {
    const ix = getInitializeInstruction(
      {
        authority: FAKE_ADDR_1,
        gameSession: FAKE_ADDR_2,
        house: FAKE_ADDR_3,
        dealer: FAKE_ADDR_4,
        treasury: FAKE_ADDR_5,
        tokenMint: FAKE_ADDR_6,
      },
      { gameId: 1n, bump: 254, vaultBump: 253, treasuryFeeBps: 200 },
    );

    assert.equal(ix.programAddress, PUSHFLIP_PROGRAM_ID);
    assert.equal(ix.data[0], Instructions.Initialize);
    // game_id at [1..9]
    assert.equal(new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(1, true), 1n);
    assert.equal(ix.data[9], 254);  // bump
    assert.equal(ix.data[10], 253); // vault_bump
    assert.equal(ix.data[11], 200); // treasury_fee_bps lo
    assert.equal(ix.data[12], 0);   // treasury_fee_bps hi
    assert.equal(ix.data.length, 13);

    // 7 accounts
    assert.equal(ix.accounts.length, 7);
    assert.equal(ix.accounts[0].address, FAKE_ADDR_1);
    assert.equal(ix.accounts[0].role, AccountRole.WRITABLE_SIGNER);
    assert.equal(ix.accounts[6].address, SYSTEM_PROGRAM_ID);
  });

  it("getInitializeInstruction omits treasury_fee_bps when not provided", () => {
    const ix = getInitializeInstruction(
      {
        authority: FAKE_ADDR_1,
        gameSession: FAKE_ADDR_2,
        house: FAKE_ADDR_3,
        dealer: FAKE_ADDR_4,
        treasury: FAKE_ADDR_5,
        tokenMint: FAKE_ADDR_6,
      },
      { gameId: 7n, bump: 255, vaultBump: 254 },
    );
    assert.equal(ix.data.length, 11); // discriminator + 8 + 1 + 1, no fee
  });

  it("getCommitDeckInstruction validates proof field lengths", () => {
    assert.throws(
      () =>
        getCommitDeckInstruction(
          { gameSession: FAKE_ADDR_1, dealer: FAKE_ADDR_2 },
          {
            merkleRoot: new Uint8Array(32),
            proofA: new Uint8Array(63), // wrong size
            proofB: new Uint8Array(128),
            proofC: new Uint8Array(64),
          },
        ),
      /proofA must be 64 bytes/,
    );
  });

  it("getCommitDeckInstruction encodes 289-byte payload", () => {
    const ix = getCommitDeckInstruction(
      { gameSession: FAKE_ADDR_1, dealer: FAKE_ADDR_2 },
      {
        merkleRoot: new Uint8Array(32).fill(1),
        proofA: new Uint8Array(64).fill(2),
        proofB: new Uint8Array(128).fill(3),
        proofC: new Uint8Array(64).fill(4),
      },
    );
    assert.equal(ix.data[0], Instructions.CommitDeck);
    assert.equal(ix.data.length, 1 + 32 + 64 + 128 + 64); // 289
    assert.equal(ix.accounts.length, 2);
    assert.equal(ix.accounts[1].role, AccountRole.READONLY_SIGNER);
  });

  it("getJoinRoundInstruction encodes bump and stake_amount", () => {
    const ix = getJoinRoundInstruction(
      {
        gameSession: FAKE_ADDR_1,
        playerState: FAKE_ADDR_2,
        player: FAKE_ADDR_3,
        playerTokenAccount: FAKE_ADDR_4,
        vault: FAKE_ADDR_5,
      },
      { bump: 250, stakeAmount: 100_000_000_000n },
    );
    assert.equal(ix.data[0], Instructions.JoinRound);
    assert.equal(ix.data[1], 250);
    assert.equal(
      new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(2, true),
      100_000_000_000n,
    );
    assert.equal(ix.data.length, 10);
    assert.equal(ix.accounts.length, 7);
    assert.equal(ix.accounts[2].role, AccountRole.WRITABLE_SIGNER); // player
    assert.equal(ix.accounts[6].address, TOKEN_PROGRAM_ID);
  });

  it("getStartRoundInstruction includes variable player states", () => {
    const ix = getStartRoundInstruction({
      gameSession: FAKE_ADDR_1,
      authority: FAKE_ADDR_2,
      playerStates: [FAKE_ADDR_3, FAKE_ADDR_4, FAKE_ADDR_5],
    });
    assert.equal(ix.data.length, 1);
    assert.equal(ix.data[0], Instructions.StartRound);
    assert.equal(ix.accounts.length, 5);
    assert.equal(ix.accounts[2].role, AccountRole.WRITABLE);
    assert.equal(ix.accounts[4].address, FAKE_ADDR_5);
  });

  it("getHitInstruction encodes 228-byte payload", () => {
    const proof = Array.from({ length: 7 }, (_, i) =>
      new Uint8Array(32).fill(i + 1),
    );
    const ix = getHitInstruction(
      { gameSession: FAKE_ADDR_1, playerState: FAKE_ADDR_2, player: FAKE_ADDR_3 },
      {
        cardValue: 7,
        cardType: 0,
        cardSuit: 2,
        merkleProof: proof,
        leafIndex: 5,
      },
    );
    assert.equal(ix.data.length, 1 + 3 + 224 + 1); // 229 (discriminator + 3 + 224 + 1)
    assert.equal(ix.data[0], Instructions.Hit);
    assert.equal(ix.data[1], 7); // value
    assert.equal(ix.data[2], 0); // type
    assert.equal(ix.data[3], 2); // suit
    assert.equal(ix.data[4], 1); // first proof byte
    assert.equal(ix.data[228], 5); // leaf_index
  });

  it("getHitInstruction rejects wrong proof length", () => {
    assert.throws(
      () =>
        getHitInstruction(
          {
            gameSession: FAKE_ADDR_1,
            playerState: FAKE_ADDR_2,
            player: FAKE_ADDR_3,
          },
          {
            cardValue: 1,
            cardType: 0,
            cardSuit: 0,
            merkleProof: [new Uint8Array(32)], // only 1 sibling
            leafIndex: 0,
          },
        ),
      /merkleProof must have 7 siblings/,
    );
  });

  it("getStayInstruction is just the discriminator", () => {
    const ix = getStayInstruction({
      gameSession: FAKE_ADDR_1,
      playerState: FAKE_ADDR_2,
      player: FAKE_ADDR_3,
    });
    assert.equal(ix.data.length, 1);
    assert.equal(ix.data[0], Instructions.Stay);
    assert.equal(ix.accounts.length, 3);
  });

  it("getEndRoundInstruction passes player_states as readonly", () => {
    const ix = getEndRoundInstruction({
      gameSession: FAKE_ADDR_1,
      caller: FAKE_ADDR_2,
      vault: FAKE_ADDR_3,
      winnerTokenAccount: FAKE_ADDR_4,
      treasuryTokenAccount: FAKE_ADDR_5,
      playerStates: [FAKE_ADDR_6],
    });
    assert.equal(ix.data.length, 1);
    assert.equal(ix.accounts.length, 7); // 6 fixed + 1 player state
    assert.equal(ix.accounts[6].role, AccountRole.READONLY);
  });

  it("getCloseGameInstruction has 3 accounts", () => {
    const ix = getCloseGameInstruction({
      gameSession: FAKE_ADDR_1,
      authority: FAKE_ADDR_2,
      recipient: FAKE_ADDR_3,
    });
    assert.equal(ix.data[0], Instructions.CloseGame);
    assert.equal(ix.accounts.length, 3);
  });

  it("getLeaveGameInstruction has 4 accounts", () => {
    const ix = getLeaveGameInstruction({
      gameSession: FAKE_ADDR_1,
      playerState: FAKE_ADDR_2,
      player: FAKE_ADDR_3,
      recipient: FAKE_ADDR_4,
    });
    assert.equal(ix.data[0], Instructions.LeaveGame);
    assert.equal(ix.accounts.length, 4);
  });

  it("getBurnSecondChanceInstruction has 6 accounts", () => {
    const ix = getBurnSecondChanceInstruction({
      gameSession: FAKE_ADDR_1,
      playerState: FAKE_ADDR_2,
      player: FAKE_ADDR_3,
      playerTokenAccount: FAKE_ADDR_4,
      tokenMint: FAKE_ADDR_5,
    });
    assert.equal(ix.data[0], Instructions.BurnSecondChance);
    assert.equal(ix.accounts.length, 6);
    assert.equal(ix.accounts[0].role, AccountRole.READONLY); // game_session readonly here
    assert.equal(ix.accounts[1].role, AccountRole.WRITABLE); // player_state
    assert.equal(ix.accounts[5].address, TOKEN_PROGRAM_ID);
  });

  it("getBurnScryInstruction has 6 accounts", () => {
    const ix = getBurnScryInstruction({
      gameSession: FAKE_ADDR_1,
      playerState: FAKE_ADDR_2,
      player: FAKE_ADDR_3,
      playerTokenAccount: FAKE_ADDR_4,
      tokenMint: FAKE_ADDR_5,
    });
    assert.equal(ix.data[0], Instructions.BurnScry);
    assert.equal(ix.accounts.length, 6);
  });
});

// --- Account deserializers ---

describe("Account deserializers", () => {
  it("decodeGameSession reads basic fields", () => {
    const data = new Uint8Array(512);
    data[0] = GAME_SESSION_DISCRIMINATOR;
    data[1] = 254; // bump
    // game_id = 42
    data.set(u64Le(42n), 2);
    // player_count = 2
    data[202] = 2;
    // round_active = true
    data[332] = 1;
    // pot_amount = 250 billion
    data.set(u64Le(250_000_000_000n), 341);
    // deck_committed = true
    data[381] = 1;
    // draw_counter = 7
    data[382] = 7;
    // treasury_fee_bps = 200
    data[383] = 200;
    data[384] = 0;
    // vault_bump = 250
    data[394] = 250;

    const gs = decodeGameSession(data);
    assert.equal(gs.bump, 254);
    assert.equal(gs.gameId, 42n);
    assert.equal(gs.playerCount, 2);
    assert.equal(gs.roundActive, true);
    assert.equal(gs.potAmount, 250_000_000_000n);
    assert.equal(gs.deckCommitted, true);
    assert.equal(gs.drawCounter, 7);
    assert.equal(gs.treasuryFeeBps, 200);
    assert.equal(gs.vaultBump, 250);
    assert.equal(gs.turnOrder.length, MAX_PLAYERS);
  });

  it("decodeGameSession rejects wrong discriminator", () => {
    const data = new Uint8Array(512);
    data[0] = 99;
    assert.throws(() => decodeGameSession(data), /Not a GameSession/);
  });

  it("decodeGameSession rejects too-short buffer", () => {
    assert.throws(() => decodeGameSession(new Uint8Array(100)), /too short/);
  });

  it("decodePlayerState reads hand and flags", () => {
    const data = new Uint8Array(256);
    data[0] = PLAYER_STATE_DISCRIMINATOR;
    data[1] = 252; // bump
    data.set(u64Le(7n), 34); // game_id
    data[42] = 2; // hand_size
    // Card 0: value=7, type=0 (alpha), suit=1
    data[43] = 7;
    data[44] = 0;
    data[45] = 1;
    // Card 1: value=10, type=0, suit=2
    data[46] = 10;
    data[47] = 0;
    data[48] = 2;
    data[73] = 1; // is_active
    data[74] = 0; // ACTIVE
    data.set(u64Le(17n), 76); // score = 17
    data.set(u64Le(100_000_000_000n), 84); // staked_amount

    const ps = decodePlayerState(data);
    assert.equal(ps.bump, 252);
    assert.equal(ps.gameId, 7n);
    assert.equal(ps.handSize, 2);
    assert.equal(ps.hand.length, 2);
    assert.equal(ps.hand[0].value, 7);
    assert.equal(ps.hand[1].value, 10);
    assert.equal(ps.isActive, true);
    assert.equal(ps.score, 17n);
    assert.equal(ps.stakedAmount, 100_000_000_000n);
  });

  it("decodePlayerState rejects wrong discriminator", () => {
    const data = new Uint8Array(256);
    data[0] = 1; // looks like GameSession
    assert.throws(() => decodePlayerState(data), /Not a PlayerState/);
  });

  it("decodeBountyBoard reads bounty entries", () => {
    const data = new Uint8Array(1500);
    data[0] = BOUNTY_BOARD_DISCRIMINATOR;
    data[1] = 251; // bump
    data[34] = 2; // bounty_count

    // Bounty 0 at offset 35
    data[35] = 0; // SevenCardWin
    data.set(u64Le(1_000_000_000_000n), 36); // reward = 1000 FLIP
    data[44] = 1; // is_active

    // Bounty 1 at offset 35 + 42 = 77
    data[77] = 1; // HighScore
    data.set(u64Le(500_000_000_000n), 78);
    data[86] = 1;

    const bb = decodeBountyBoard(data);
    assert.equal(bb.bump, 251);
    assert.equal(bb.bountyCount, 2);
    assert.equal(bb.bounties.length, 2);
    assert.equal(bb.bounties[0].rewardAmount, 1_000_000_000_000n);
    assert.equal(bb.bounties[0].isActive, true);
    assert.equal(bb.bounties[1].rewardAmount, 500_000_000_000n);
  });
});

// --- Kit transaction-builder integration ---
//
// Catches type-system regressions where an instruction returned by one of
// our builders cannot be appended to a Kit @solana/kit transaction message.
// Pure encoding tests above would not catch a `Instruction<T>` generic
// parameter weakening or an `accounts` shape mismatch — this would.
describe("parseU64", () => {
  it("accepts positive decimal integers", () => {
    assert.equal(parseU64("0", "stake"), 0n);
    assert.equal(parseU64("1", "stake"), 1n);
    assert.equal(parseU64("1000", "stake"), 1000n);
    assert.equal(
      parseU64("18446744073709551615", "stake"),
      U64_MAX,
    );
  });

  it("rejects the empty string", () => {
    assert.throws(() => parseU64("", "stake"), /Invalid stake/);
  });

  it("rejects hex prefixes", () => {
    assert.throws(() => parseU64("0xff", "stake"), /Invalid stake/);
    assert.throws(() => parseU64("0X10", "stake"), /Invalid stake/);
  });

  it("rejects negatives", () => {
    assert.throws(() => parseU64("-1", "stake"), /Invalid stake/);
    assert.throws(() => parseU64("-100", "stake"), /Invalid stake/);
  });

  it("rejects decimals and scientific notation", () => {
    assert.throws(() => parseU64("1.5", "stake"), /Invalid stake/);
    assert.throws(() => parseU64("1e10", "stake"), /Invalid stake/);
    assert.throws(() => parseU64("1E10", "stake"), /Invalid stake/);
  });

  it("rejects values above u64::MAX", () => {
    // 2^64 — one past u64::MAX
    assert.throws(
      () => parseU64("18446744073709551616", "stake"),
      /exceeds u64 max/,
    );
    // Comfortably above u64::MAX
    assert.throws(
      () => parseU64("999999999999999999999", "stake"),
      /exceeds u64 max/,
    );
  });

  it("rejects whitespace and non-digit junk", () => {
    assert.throws(() => parseU64(" 100", "stake"), /Invalid stake/);
    assert.throws(() => parseU64("100 ", "stake"), /Invalid stake/);
    assert.throws(() => parseU64("10_000", "stake"), /Invalid stake/);
    assert.throws(() => parseU64("abc", "stake"), /Invalid stake/);
  });

  it("uses the supplied field name in error messages", () => {
    assert.throws(
      () => parseU64("-1", "game_id"),
      /Invalid game_id/,
    );
  });

  it("bounds-checks before u64Le encoding (silent-wrap guard)", () => {
    // This is the exact footgun parseU64 exists to prevent: if a caller
    // skipped parseU64 and passed raw `BigInt("18446744073709551616")`
    // into u64Le, setBigUint64 would silently wrap it to 0n. parseU64
    // must reject that value so no caller ever gets a wrapped bigint.
    assert.throws(
      () => parseU64("18446744073709551616", "stake"),
      /exceeds u64 max/,
    );
    // And the valid boundary value still round-trips through u64Le.
    const max = parseU64("18446744073709551615", "stake");
    const bytes = u64Le(max);
    assert.equal(bytes.length, 8);
    // All bytes should be 0xff for u64::MAX
    for (const b of bytes) {
      assert.equal(b, 0xff);
    }
  });
});

describe("Kit transaction-builder integration", () => {
  it("instruction can be appended to a Kit transaction message", () => {
    const ix = getStayInstruction({
      gameSession: FAKE_ADDR_1,
      playerState: FAKE_ADDR_2,
      player: FAKE_ADDR_3,
    });

    // The structural compatibility of `PushflipInstruction` with Kit's
    // `Instruction` interface is asserted at compile time by passing it
    // through `appendTransactionMessageInstruction`. If the types ever
    // drift, tsc will fail before this test runs.
    const message = pipe(createTransactionMessage({ version: 0 }), (m) =>
      appendTransactionMessageInstruction(ix, m),
    );

    assert.equal(message.instructions.length, 1);
    assert.equal(message.instructions[0]?.programAddress, PUSHFLIP_PROGRAM_ID);
    assert.equal(message.instructions[0]?.accounts?.length, ix.accounts.length);
  });
});
