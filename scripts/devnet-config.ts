/**
 * Devnet test configuration — addresses for off-chain test artifacts
 * that live on devnet but aren't part of the program itself.
 *
 * These are NOT secrets. The mint authority is the local CLI wallet
 * (~/.config/solana/id.json) and the test mint is freely mintable to
 * any account by anyone holding that authority key.
 *
 * The canonical mint address lives in `@pushflip/client/constants.ts`
 * — this module re-exports it so existing imports keep working while
 * there is exactly one source of truth. (16th heavy-duty review M1 —
 * avoid drift across 3 copies.)
 */

export { TEST_FLIP_MINT } from "@pushflip/client";
