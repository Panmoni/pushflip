/**
 * Instruction builders for the pushflip program.
 *
 * Each builder returns an `Instruction` ready for use with @solana/kit's
 * transaction builder. Account orders and data layouts must match
 * program/src/instructions/*.rs exactly.
 */

import {
  type AccountMeta,
  AccountRole,
  type Address,
  type Instruction,
  type InstructionWithAccounts,
  type InstructionWithData,
} from "@solana/kit";

import { concatBytes, u16Le, u64Le } from "./bytes.js";
import {
  Instructions,
  PUSHFLIP_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./constants.js";

type PushflipInstruction = Instruction<typeof PUSHFLIP_PROGRAM_ID> &
  InstructionWithAccounts<readonly AccountMeta[]> &
  InstructionWithData<Uint8Array>;

function buildIx(
  data: Uint8Array,
  accounts: readonly AccountMeta[],
): PushflipInstruction {
  return {
    programAddress: PUSHFLIP_PROGRAM_ID,
    accounts,
    data,
  };
}

// --- 0: Initialize ---

export interface InitializeAccounts {
  authority: Address;
  gameSession: Address;
  house: Address;
  dealer: Address;
  treasury: Address;
  tokenMint: Address;
}

export interface InitializeData {
  gameId: bigint;
  bump: number;
  vaultBump: number;
  /** Optional treasury fee basis points (0-9999). Defaults to 200 (2%). */
  treasuryFeeBps?: number;
}

export function getInitializeInstruction(
  accounts: InitializeAccounts,
  data: InitializeData,
): PushflipInstruction {
  const parts: Uint8Array[] = [
    new Uint8Array([Instructions.Initialize]),
    u64Le(data.gameId),
    new Uint8Array([data.bump, data.vaultBump]),
  ];
  if (data.treasuryFeeBps !== undefined) {
    parts.push(u16Le(data.treasuryFeeBps));
  }

  return buildIx(concatBytes(...parts), [
    { address: accounts.authority, role: AccountRole.WRITABLE_SIGNER },
    { address: accounts.gameSession, role: AccountRole.WRITABLE },
    { address: accounts.house, role: AccountRole.READONLY },
    { address: accounts.dealer, role: AccountRole.READONLY },
    { address: accounts.treasury, role: AccountRole.READONLY },
    { address: accounts.tokenMint, role: AccountRole.READONLY },
    { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
  ]);
}

// --- 1: CommitDeck ---

export interface CommitDeckAccounts {
  gameSession: Address;
  dealer: Address;
}

export interface CommitDeckData {
  /** 32 bytes */
  merkleRoot: Uint8Array;
  /** 64 bytes (G1, negated, big-endian) */
  proofA: Uint8Array;
  /** 128 bytes (G2, big-endian) */
  proofB: Uint8Array;
  /** 64 bytes (G1, big-endian) */
  proofC: Uint8Array;
}

export function getCommitDeckInstruction(
  accounts: CommitDeckAccounts,
  data: CommitDeckData,
): PushflipInstruction {
  if (data.merkleRoot.length !== 32) {
    throw new Error(`merkleRoot must be 32 bytes, got ${data.merkleRoot.length}`);
  }
  if (data.proofA.length !== 64) {
    throw new Error(`proofA must be 64 bytes, got ${data.proofA.length}`);
  }
  if (data.proofB.length !== 128) {
    throw new Error(`proofB must be 128 bytes, got ${data.proofB.length}`);
  }
  if (data.proofC.length !== 64) {
    throw new Error(`proofC must be 64 bytes, got ${data.proofC.length}`);
  }

  const ixData = concatBytes(
    new Uint8Array([Instructions.CommitDeck]),
    data.merkleRoot,
    data.proofA,
    data.proofB,
    data.proofC,
  );

  return buildIx(ixData, [
    { address: accounts.gameSession, role: AccountRole.WRITABLE },
    { address: accounts.dealer, role: AccountRole.READONLY_SIGNER },
  ]);
}

// --- 2: JoinRound ---

export interface JoinRoundAccounts {
  gameSession: Address;
  playerState: Address;
  player: Address;
  playerTokenAccount: Address;
  vault: Address;
}

export interface JoinRoundData {
  /** PlayerState PDA bump */
  bump: number;
  /** Stake amount in base units */
  stakeAmount: bigint;
}

export function getJoinRoundInstruction(
  accounts: JoinRoundAccounts,
  data: JoinRoundData,
): PushflipInstruction {
  const ixData = concatBytes(
    new Uint8Array([Instructions.JoinRound, data.bump]),
    u64Le(data.stakeAmount),
  );

  return buildIx(ixData, [
    { address: accounts.gameSession, role: AccountRole.WRITABLE },
    { address: accounts.playerState, role: AccountRole.WRITABLE },
    { address: accounts.player, role: AccountRole.WRITABLE_SIGNER },
    { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
    { address: accounts.playerTokenAccount, role: AccountRole.WRITABLE },
    { address: accounts.vault, role: AccountRole.WRITABLE },
    { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
  ]);
}

// --- 3: StartRound ---

export interface StartRoundAccounts {
  gameSession: Address;
  authority: Address;
  /** Player state accounts in turn_order order (length === playerCount). */
  playerStates: Address[];
}

export function getStartRoundInstruction(
  accounts: StartRoundAccounts,
): PushflipInstruction {
  const accountMetas = [
    { address: accounts.gameSession, role: AccountRole.WRITABLE },
    { address: accounts.authority, role: AccountRole.READONLY_SIGNER },
    ...accounts.playerStates.map((address) => ({
      address,
      role: AccountRole.WRITABLE,
    })),
  ];

  return buildIx(new Uint8Array([Instructions.StartRound]), accountMetas);
}

// --- 4: Hit ---

export interface HitAccounts {
  gameSession: Address;
  playerState: Address;
  player: Address;
  /**
   * Optional accounts for protocol card effects (RUG_PULL, VAMPIRE_ATTACK).
   * Pass other player_state PDAs in turn_order if any may be targeted.
   */
  remainingAccounts?: Address[];
}

export interface HitData {
  cardValue: number;
  cardType: number;
  cardSuit: number;
  /** 7 sibling hashes, 32 bytes each = 224 bytes total */
  merkleProof: Uint8Array[];
  leafIndex: number;
}

export function getHitInstruction(
  accounts: HitAccounts,
  data: HitData,
): PushflipInstruction {
  if (data.merkleProof.length !== 7) {
    throw new Error(
      `merkleProof must have 7 siblings, got ${data.merkleProof.length}`,
    );
  }
  for (const [i, sibling] of data.merkleProof.entries()) {
    if (sibling.length !== 32) {
      throw new Error(
        `merkleProof[${i}] must be 32 bytes, got ${sibling.length}`,
      );
    }
  }

  const ixData = concatBytes(
    new Uint8Array([
      Instructions.Hit,
      data.cardValue,
      data.cardType,
      data.cardSuit,
    ]),
    ...data.merkleProof,
    new Uint8Array([data.leafIndex]),
  );

  const accountMetas = [
    { address: accounts.gameSession, role: AccountRole.WRITABLE },
    { address: accounts.playerState, role: AccountRole.WRITABLE },
    { address: accounts.player, role: AccountRole.READONLY_SIGNER },
    ...(accounts.remainingAccounts ?? []).map((address) => ({
      address,
      role: AccountRole.WRITABLE,
    })),
  ];

  return buildIx(ixData, accountMetas);
}

// --- 5: Stay ---

export interface StayAccounts {
  gameSession: Address;
  playerState: Address;
  player: Address;
}

export function getStayInstruction(
  accounts: StayAccounts,
): PushflipInstruction {
  return buildIx(new Uint8Array([Instructions.Stay]), [
    { address: accounts.gameSession, role: AccountRole.WRITABLE },
    { address: accounts.playerState, role: AccountRole.WRITABLE },
    { address: accounts.player, role: AccountRole.READONLY_SIGNER },
  ]);
}

// --- 6: EndRound ---

export interface EndRoundAccounts {
  gameSession: Address;
  caller: Address;
  vault: Address;
  winnerTokenAccount: Address;
  treasuryTokenAccount: Address;
  /** Player state accounts in turn_order order. */
  playerStates: Address[];
}

export function getEndRoundInstruction(
  accounts: EndRoundAccounts,
): PushflipInstruction {
  const accountMetas = [
    { address: accounts.gameSession, role: AccountRole.WRITABLE },
    { address: accounts.caller, role: AccountRole.READONLY_SIGNER },
    { address: accounts.vault, role: AccountRole.WRITABLE },
    { address: accounts.winnerTokenAccount, role: AccountRole.WRITABLE },
    { address: accounts.treasuryTokenAccount, role: AccountRole.WRITABLE },
    { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
    ...accounts.playerStates.map((address) => ({
      address,
      role: AccountRole.READONLY,
    })),
  ];

  return buildIx(new Uint8Array([Instructions.EndRound]), accountMetas);
}

// --- 7: CloseGame ---

export interface CloseGameAccounts {
  gameSession: Address;
  authority: Address;
  recipient: Address;
}

export function getCloseGameInstruction(
  accounts: CloseGameAccounts,
): PushflipInstruction {
  return buildIx(new Uint8Array([Instructions.CloseGame]), [
    { address: accounts.gameSession, role: AccountRole.WRITABLE },
    { address: accounts.authority, role: AccountRole.READONLY_SIGNER },
    { address: accounts.recipient, role: AccountRole.WRITABLE },
  ]);
}

// --- 8: LeaveGame ---

export interface LeaveGameAccounts {
  gameSession: Address;
  playerState: Address;
  player: Address;
  recipient: Address;
}

export function getLeaveGameInstruction(
  accounts: LeaveGameAccounts,
): PushflipInstruction {
  return buildIx(new Uint8Array([Instructions.LeaveGame]), [
    { address: accounts.gameSession, role: AccountRole.WRITABLE },
    { address: accounts.playerState, role: AccountRole.WRITABLE },
    { address: accounts.player, role: AccountRole.READONLY_SIGNER },
    { address: accounts.recipient, role: AccountRole.WRITABLE },
  ]);
}

// --- 9: BurnSecondChance ---

export interface BurnSecondChanceAccounts {
  gameSession: Address;
  playerState: Address;
  player: Address;
  playerTokenAccount: Address;
  tokenMint: Address;
}

export function getBurnSecondChanceInstruction(
  accounts: BurnSecondChanceAccounts,
): PushflipInstruction {
  return buildIx(new Uint8Array([Instructions.BurnSecondChance]), [
    { address: accounts.gameSession, role: AccountRole.READONLY },
    { address: accounts.playerState, role: AccountRole.WRITABLE },
    { address: accounts.player, role: AccountRole.READONLY_SIGNER },
    { address: accounts.playerTokenAccount, role: AccountRole.WRITABLE },
    { address: accounts.tokenMint, role: AccountRole.WRITABLE },
    { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
  ]);
}

// --- 10: BurnScry ---

export interface BurnScryAccounts {
  gameSession: Address;
  playerState: Address;
  player: Address;
  playerTokenAccount: Address;
  tokenMint: Address;
}

export function getBurnScryInstruction(
  accounts: BurnScryAccounts,
): PushflipInstruction {
  return buildIx(new Uint8Array([Instructions.BurnScry]), [
    { address: accounts.gameSession, role: AccountRole.READONLY },
    { address: accounts.playerState, role: AccountRole.WRITABLE },
    { address: accounts.player, role: AccountRole.READONLY_SIGNER },
    { address: accounts.playerTokenAccount, role: AccountRole.WRITABLE },
    { address: accounts.tokenMint, role: AccountRole.WRITABLE },
    { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
  ]);
}

// --- 11: InitVault ---

export interface InitVaultAccounts {
  /** Funds rent for the vault token account. Usually the authority. */
  payer: Address;
  /** Existing GameSession PDA. Read-only — supplies vault, vault_bump, token_mint. */
  gameSession: Address;
  /** Vault PDA — will be created and initialized as an SPL token account. */
  vault: Address;
  /** Token mint, must match game_session.token_mint. */
  tokenMint: Address;
}

/**
 * Create the SPL token account at the vault PDA address. Optional —
 * games that don't need real token transfers (vault_ready=false) can
 * skip this. Must be called after `initialize` and before any
 * `join_round` that should transfer real tokens.
 *
 * The pushflip program signs with the vault PDA seeds during the
 * `system::create_account` CPI, so this is the only on-chain way to
 * place a token account at the vault PDA address.
 */
export function getInitVaultInstruction(
  accounts: InitVaultAccounts,
): PushflipInstruction {
  return buildIx(new Uint8Array([Instructions.InitVault]), [
    { address: accounts.payer, role: AccountRole.WRITABLE_SIGNER },
    { address: accounts.gameSession, role: AccountRole.READONLY },
    { address: accounts.vault, role: AccountRole.WRITABLE },
    { address: accounts.tokenMint, role: AccountRole.READONLY },
    { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
    { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
  ]);
}

// --- 12: InitBountyBoard ---

export interface InitBountyBoardAccounts {
  /** Funds rent for the bounty board PDA. Must be the game_session.authority. */
  payer: Address;
  /** Existing GameSession PDA. */
  gameSession: Address;
  /** BountyBoard PDA at ["bounty", game_session_address] — will be created. */
  bountyBoard: Address;
}

export interface InitBountyBoardArgs {
  /** PDA bump seed for the bounty board (client-derived). */
  bump: number;
}

/**
 * Create the BountyBoard PDA for a game session. Optional — games that
 * don't use bounties can skip this. Only the game_session.authority can
 * call it. The bounty board has fixed capacity (`MAX_BOUNTIES = 10`).
 */
export function getInitBountyBoardInstruction(
  accounts: InitBountyBoardAccounts,
  args: InitBountyBoardArgs,
): PushflipInstruction {
  return buildIx(new Uint8Array([Instructions.InitBountyBoard, args.bump]), [
    { address: accounts.payer, role: AccountRole.WRITABLE_SIGNER },
    { address: accounts.gameSession, role: AccountRole.READONLY },
    { address: accounts.bountyBoard, role: AccountRole.WRITABLE },
    { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
  ]);
}

// --- 13: AddBounty ---

export interface AddBountyAccounts {
  /** Game authority. */
  authority: Address;
  /** GameSession (read-only — used for the authority check). */
  gameSession: Address;
  /** BountyBoard PDA. */
  bountyBoard: Address;
}

export interface AddBountyArgs {
  /**
   * 0 = SEVEN_CARD_WIN, 1 = HIGH_SCORE, 2 = SURVIVOR, 3 = COMEBACK.
   * See `program/src/state/bounty.rs` constants.
   */
  bountyType: number;
  /**
   * Reward metadata. For HIGH_SCORE bounties this field doubles as the
   * score threshold the player must meet to claim. For other types it's
   * an off-chain payout amount that the on-chain claim does NOT
   * actually transfer (claim_bounty only marks the claim).
   */
  rewardAmount: bigint;
}

export function getAddBountyInstruction(
  accounts: AddBountyAccounts,
  args: AddBountyArgs,
): PushflipInstruction {
  const data = concatBytes(
    new Uint8Array([Instructions.AddBounty, args.bountyType]),
    u64Le(args.rewardAmount),
  );
  return buildIx(data, [
    { address: accounts.authority, role: AccountRole.READONLY_SIGNER },
    { address: accounts.gameSession, role: AccountRole.READONLY },
    { address: accounts.bountyBoard, role: AccountRole.WRITABLE },
  ]);
}

// --- 14: ClaimBounty ---

export interface ClaimBountyAccounts {
  /** Player claiming the bounty. */
  player: Address;
  /** GameSession (read-only — verifies player is in turn_order). */
  gameSession: Address;
  /** Player's PlayerState (read-only — verifies win condition). */
  playerState: Address;
  /** BountyBoard PDA. */
  bountyBoard: Address;
}

export interface ClaimBountyArgs {
  /** Index of the bounty in the board (0..bountyCount). */
  bountyIndex: number;
}

/**
 * Player records their claim of a bounty. The on-chain side verifies
 * the win condition and marks the claim. **No tokens are transferred
 * on chain** — the authority is responsible for paying out the
 * `rewardAmount` (off-chain or via a separate token transfer
 * instruction).
 */
export function getClaimBountyInstruction(
  accounts: ClaimBountyAccounts,
  args: ClaimBountyArgs,
): PushflipInstruction {
  return buildIx(
    new Uint8Array([Instructions.ClaimBounty, args.bountyIndex]),
    [
      { address: accounts.player, role: AccountRole.READONLY_SIGNER },
      { address: accounts.gameSession, role: AccountRole.READONLY },
      { address: accounts.playerState, role: AccountRole.READONLY },
      { address: accounts.bountyBoard, role: AccountRole.WRITABLE },
    ],
  );
}

// --- 15: CloseBountyBoard ---

export interface CloseBountyBoardAccounts {
  bountyBoard: Address;
  /** Game authority. */
  authority: Address;
  gameSession: Address;
  /** Receives the rent lamports. */
  recipient: Address;
}

export function getCloseBountyBoardInstruction(
  accounts: CloseBountyBoardAccounts,
): PushflipInstruction {
  return buildIx(new Uint8Array([Instructions.CloseBountyBoard]), [
    { address: accounts.bountyBoard, role: AccountRole.WRITABLE },
    { address: accounts.authority, role: AccountRole.READONLY_SIGNER },
    { address: accounts.gameSession, role: AccountRole.READONLY },
    { address: accounts.recipient, role: AccountRole.WRITABLE },
  ]);
}
