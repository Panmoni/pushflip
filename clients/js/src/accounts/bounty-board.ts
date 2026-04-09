/**
 * BountyBoard account deserializer.
 * Layout must match program/src/state/bounty.rs exactly.
 */

import type { Address } from "@solana/kit";

import { ByteReader, checkEnum } from "../bytes.js";
import { BOUNTY_BOARD_DISCRIMINATOR, MAX_BOUNTIES } from "../constants.js";

/** Bounty type discriminants from program/src/state/bounty.rs */
export const enum BountyType {
  SevenCardWin = 0,
  HighScore = 1,
  Survivor = 2,
  Comeback = 3,
}

export interface Bounty {
  bountyType: BountyType;
  rewardAmount: bigint;
  isActive: boolean;
  /** Zero address (32 bytes of zero) if unclaimed. */
  claimedBy: Uint8Array;
}

export interface BountyBoard {
  bump: number;
  gameSession: Address;
  bountyCount: number;
  /** Active bounties (length === bountyCount). */
  bounties: Bounty[];
}

/**
 * Deserialize a BountyBoard account from raw bytes.
 * @throws if the discriminator doesn't match or the buffer is too short.
 */
export function decodeBountyBoard(data: Uint8Array): BountyBoard {
  if (data.length < 455) {
    throw new Error(
      `BountyBoard data too short: ${data.length} bytes (need >= 455)`,
    );
  }

  const r = new ByteReader(data);
  const discriminator = r.u8();
  if (discriminator !== BOUNTY_BOARD_DISCRIMINATOR) {
    throw new Error(
      `Not a BountyBoard account (discriminator ${discriminator}, expected ${BOUNTY_BOARD_DISCRIMINATOR})`,
    );
  }

  const bump = r.u8();
  const gameSession = r.pubkey();
  const bountyCount = r.u8();

  const bounties: Bounty[] = [];
  for (let i = 0; i < MAX_BOUNTIES; i++) {
    const bountyTypeRaw = r.u8();
    const rewardAmount = r.u64();
    const isActive = r.bool();
    const claimedBy = r.bytes32();
    if (i < bountyCount) {
      // Only validate enum range for active bounty slots (unused slots are zero-padded)
      const bountyType = checkEnum<BountyType>(bountyTypeRaw, 3, "BountyType");
      bounties.push({ bountyType, rewardAmount, isActive, claimedBy });
    }
  }

  return { bump, gameSession, bountyCount, bounties };
}
