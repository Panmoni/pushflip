/**
 * PlayerState account deserializer.
 * Layout must match program/src/state/player_state.rs exactly.
 */

import type { Address } from "@solana/kit";

import { ByteReader, checkEnum } from "../bytes.js";
import {
  type CardType,
  InactiveReason,
  MAX_HAND_SIZE,
  PLAYER_STATE_DISCRIMINATOR,
} from "../constants.js";

export interface Card {
  value: number;
  cardType: CardType;
  suit: number;
}

export interface PlayerState {
  bump: number;
  player: Address;
  gameId: bigint;
  handSize: number;
  /** Active cards in the player's hand (length === handSize). */
  hand: Card[];
  isActive: boolean;
  inactiveReason: InactiveReason;
  bustCardValue: number;
  score: bigint;
  stakedAmount: bigint;
  hasUsedSecondChance: boolean;
  hasUsedScry: boolean;
  totalWins: bigint;
  totalGames: bigint;
}

/**
 * Deserialize a PlayerState account from raw bytes.
 * @throws if the discriminator doesn't match or the buffer is too short.
 */
export function decodePlayerState(data: Uint8Array): PlayerState {
  if (data.length < 110) {
    throw new Error(
      `PlayerState data too short: ${data.length} bytes (need >= 110)`,
    );
  }

  const r = new ByteReader(data);
  const discriminator = r.u8();
  if (discriminator !== PLAYER_STATE_DISCRIMINATOR) {
    throw new Error(
      `Not a PlayerState account (discriminator ${discriminator}, expected ${PLAYER_STATE_DISCRIMINATOR})`,
    );
  }

  const bump = r.u8();
  const player = r.pubkey();
  const gameId = r.u64();
  const handSize = r.u8();

  // Hand: 10 cards × 3 bytes each, but only the first `handSize` are real
  const hand: Card[] = [];
  for (let i = 0; i < MAX_HAND_SIZE; i++) {
    const value = r.u8();
    const cardTypeRaw = r.u8();
    const suit = r.u8();
    if (i < handSize) {
      // Only validate enum range for active hand slots (unused slots are zero-padded)
      const cardType = checkEnum<CardType>(cardTypeRaw, 2, "CardType");
      hand.push({ value, cardType, suit });
    }
  }

  const isActive = r.bool();
  const inactiveReason = checkEnum<InactiveReason>(r.u8(), 2, "InactiveReason");
  const bustCardValue = r.u8();
  const score = r.u64();
  const stakedAmount = r.u64();
  const hasUsedSecondChance = r.bool();
  const hasUsedScry = r.bool();
  const totalWins = r.u64();
  const totalGames = r.u64();

  return {
    bump,
    player,
    gameId,
    handSize,
    hand,
    isActive,
    inactiveReason,
    bustCardValue,
    score,
    stakedAmount,
    hasUsedSecondChance,
    hasUsedScry,
    totalWins,
    totalGames,
  };
}

/** True if the player has busted out of the round. */
export function isBust(ps: PlayerState): boolean {
  return ps.inactiveReason === InactiveReason.Bust;
}

/** True if the player has voluntarily stayed (locked in their score). */
export function hasStayed(ps: PlayerState): boolean {
  return ps.inactiveReason === InactiveReason.Stayed;
}
