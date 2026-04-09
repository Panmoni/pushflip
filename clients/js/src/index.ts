/**
 * @pushflip/client — TypeScript client for the pushflip Solana program.
 *
 * Built directly on @solana/kit (no Anchor, no Codama).
 *
 * Usage:
 * ```ts
 * import {
 *   getInitializeInstruction,
 *   deriveGamePda,
 *   decodeGameSession,
 * } from "@pushflip/client";
 *
 * const [gamePda, bump] = await deriveGamePda(1n);
 * const ix = getInitializeInstruction(
 *   { authority, gameSession: gamePda, house, dealer, treasury, tokenMint },
 *   { gameId: 1n, bump, vaultBump, treasuryFeeBps: 200 },
 * );
 * ```
 */

// Constants and enums
export * from "./constants.js";

// PDA derivation
export * from "./pda.js";

// Byte helpers
export { ByteReader, concatBytes, u16Le, u64Le } from "./bytes.js";

// Account deserializers
export {
  type GameSession,
  decodeGameSession,
  activeTurnOrder,
} from "./accounts/game-session.js";
export {
  type Card,
  type PlayerState,
  decodePlayerState,
  hasStayed,
  isBust,
} from "./accounts/player-state.js";
export {
  type Bounty,
  type BountyBoard,
  BountyType,
  decodeBountyBoard,
} from "./accounts/bounty-board.js";

// Instruction builders
export * from "./instructions.js";
