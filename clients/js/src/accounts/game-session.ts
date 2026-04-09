/**
 * GameSession account deserializer.
 * Layout must match program/src/state/game_session.rs exactly.
 */

import type { Address } from "@solana/kit";

import { ByteReader } from "../bytes.js";
import { GAME_SESSION_DISCRIMINATOR, MAX_PLAYERS } from "../constants.js";

export interface GameSession {
  bump: number;
  gameId: bigint;
  authority: Address;
  house: Address;
  dealer: Address;
  treasury: Address;
  tokenMint: Address;
  vault: Address;
  playerCount: number;
  /** turn_order — pubkeys of players. Length always MAX_PLAYERS (4); unused slots are zero. */
  turnOrder: Address[];
  currentTurnIndex: number;
  roundActive: boolean;
  roundNumber: bigint;
  potAmount: bigint;
  merkleRoot: Uint8Array;
  deckCommitted: boolean;
  drawCounter: number;
  treasuryFeeBps: number;
  rolloverCount: number;
  lastActionSlot: bigint;
  vaultBump: number;
}

/**
 * Deserialize a GameSession account from raw bytes.
 * @throws if the discriminator doesn't match or the buffer is too short.
 */
export function decodeGameSession(data: Uint8Array): GameSession {
  if (data.length < 395) {
    throw new Error(
      `GameSession data too short: ${data.length} bytes (need >= 395)`,
    );
  }

  const r = new ByteReader(data);
  const discriminator = r.u8();
  if (discriminator !== GAME_SESSION_DISCRIMINATOR) {
    throw new Error(
      `Not a GameSession account (discriminator ${discriminator}, expected ${GAME_SESSION_DISCRIMINATOR})`,
    );
  }

  const bump = r.u8();
  const gameId = r.u64();
  const authority = r.pubkey();
  const house = r.pubkey();
  const dealer = r.pubkey();
  const treasury = r.pubkey();
  const tokenMint = r.pubkey();
  const vault = r.pubkey();
  const playerCount = r.u8();

  const turnOrder: Address[] = [];
  for (let i = 0; i < MAX_PLAYERS; i++) {
    turnOrder.push(r.pubkey());
  }

  const currentTurnIndex = r.u8();
  const roundActive = r.bool();
  const roundNumber = r.u64();
  const potAmount = r.u64();
  const merkleRoot = r.bytes32();
  const deckCommitted = r.bool();
  const drawCounter = r.u8();
  const treasuryFeeBps = r.u16();
  const rolloverCount = r.u8();
  const lastActionSlot = r.u64();
  const vaultBump = r.u8();

  return {
    bump,
    gameId,
    authority,
    house,
    dealer,
    treasury,
    tokenMint,
    vault,
    playerCount,
    turnOrder,
    currentTurnIndex,
    roundActive,
    roundNumber,
    potAmount,
    merkleRoot,
    deckCommitted,
    drawCounter,
    treasuryFeeBps,
    rolloverCount,
    lastActionSlot,
    vaultBump,
  };
}

/** Get the active turn_order entries (slice off zero-padding). */
export function activeTurnOrder(gs: GameSession): Address[] {
  return gs.turnOrder.slice(0, gs.playerCount);
}
