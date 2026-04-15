/**
 * Constants — must stay in sync with program/src/utils/constants.rs and
 * the on-chain state byte layouts.
 */

import type { Address } from "@solana/kit";

/** Pushflip program ID on devnet (matches program/src/lib.rs declare_id!) */
export const PUSHFLIP_PROGRAM_ID =
  "HQLeAQc84WLz8buHM5JAJGBjNJjwc6Fpxts8jSMaW3px" as Address;

/**
 * Test `$FLIP` mint on devnet. Single source of truth — mirrored by
 * `scripts/devnet-config.ts::TEST_FLIP_MINT` and `app/src/lib/constants.ts::TOKEN_MINT`
 * (both of which re-export this constant; do not hardcode separately).
 *
 * - Decimals: 9
 * - Mint authority: local CLI wallet (3XXMLDEf2DDdmgR978U8T5GhFLnxDNDUcJ2ETDw2bUWp)
 * - Created: 2026-04-10 (Task 3.A.2 setup)
 *
 * Promotion to a permanent mint with metadata + multisig authority is
 * tracked as Pre-Mainnet 5.0.6 in docs/EXECUTION_PLAN.md.
 */
export const TEST_FLIP_MINT =
  "2KqqB7SRVaD98ZbVaiRWirxbaJv5ryNzkDRGweBZVryF" as Address;

/** SPL Token program */
export const TOKEN_PROGRAM_ID =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

/** System program */
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111" as Address;

// --- Instruction discriminators ---
export const enum Instructions {
  Initialize = 0,
  CommitDeck = 1,
  JoinRound = 2,
  StartRound = 3,
  Hit = 4,
  Stay = 5,
  EndRound = 6,
  CloseGame = 7,
  LeaveGame = 8,
  BurnSecondChance = 9,
  BurnScry = 10,
  InitVault = 11,
  InitBountyBoard = 12,
  AddBounty = 13,
  ClaimBounty = 14,
  CloseBountyBoard = 15,
}

// --- Account discriminators ---
export const GAME_SESSION_DISCRIMINATOR = 1;
export const PLAYER_STATE_DISCRIMINATOR = 2;
export const BOUNTY_BOARD_DISCRIMINATOR = 3;

// --- PDA seeds ---
export const GAME_SEED = new Uint8Array([
  103, 97, 109, 101,
]); // "game"
export const PLAYER_SEED = new Uint8Array([
  112, 108, 97, 121, 101, 114,
]); // "player"
export const VAULT_SEED = new Uint8Array([
  118, 97, 117, 108, 116,
]); // "vault"
export const BOUNTY_SEED = new Uint8Array([
  98, 111, 117, 110, 116, 121,
]); // "bounty"

// --- Deck constants ---
export const DECK_SIZE = 94;
export const TOTAL_LEAVES = 128;
export const MERKLE_DEPTH = 7;

// --- Card types ---
export const enum CardType {
  Alpha = 0,
  Protocol = 1,
  Multiplier = 2,
}

// --- Protocol effects ---
export const enum ProtocolEffect {
  RugPull = 0,
  Airdrop = 1,
  VampireAttack = 2,
}

// --- Player inactive reasons ---
export const enum InactiveReason {
  Active = 0,
  Bust = 1,
  Stayed = 2,
}

// --- Token economy (in base units, 9 decimals) ---
export const FLIP_DECIMALS = 9;
export const MIN_STAKE = 100_000_000_000n; // 100 $FLIP
export const SECOND_CHANCE_COST = 50_000_000_000n; // 50 $FLIP
export const SCRY_COST = 25_000_000_000n; // 25 $FLIP

// --- State sizes ---
export const GAME_SESSION_SIZE = 512;
export const PLAYER_STATE_SIZE = 256;
export const BOUNTY_BOARD_SIZE = 1500;
export const MAX_PLAYERS = 4;
export const MAX_HAND_SIZE = 10;
export const MAX_BOUNTIES = 10;
