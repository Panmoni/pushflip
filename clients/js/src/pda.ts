/**
 * PDA derivation helpers — must produce identical addresses to the
 * on-chain `Address::find_program_address` calls.
 */

import {
  type Address,
  type ProgramDerivedAddress,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/kit";

import { u64Le } from "./bytes.js";
import {
  BOUNTY_SEED,
  GAME_SEED,
  PLAYER_SEED,
  PUSHFLIP_PROGRAM_ID,
  VAULT_SEED,
} from "./constants.js";

const addressEncoder = getAddressEncoder();

/**
 * Derive the GameSession PDA.
 * Seeds: ["game", game_id (u64 LE)]
 */
export async function deriveGamePda(
  gameId: bigint,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: PUSHFLIP_PROGRAM_ID,
    seeds: [GAME_SEED, u64Le(gameId)],
  });
}

/**
 * Derive a PlayerState PDA for a given player in a given game.
 * Seeds: ["player", game_id (u64 LE), player_pubkey]
 */
export async function derivePlayerPda(
  gameId: bigint,
  player: Address,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: PUSHFLIP_PROGRAM_ID,
    seeds: [PLAYER_SEED, u64Le(gameId), addressEncoder.encode(player)],
  });
}

/**
 * Derive the vault PDA for a given game session.
 * Seeds: ["vault", game_session_pubkey]
 *
 * The vault PDA address itself is also the SPL Token account address
 * (the token account is created at this exact PDA address, not as an ATA).
 */
export async function deriveVaultPda(
  gameSession: Address,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: PUSHFLIP_PROGRAM_ID,
    seeds: [VAULT_SEED, addressEncoder.encode(gameSession)],
  });
}

/**
 * Derive the BountyBoard PDA for a given game session.
 * Seeds: ["bounty", game_session_pubkey]
 */
export async function deriveBountyPda(
  gameSession: Address,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: PUSHFLIP_PROGRAM_ID,
    seeds: [BOUNTY_SEED, addressEncoder.encode(gameSession)],
  });
}
