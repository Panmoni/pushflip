/**
 * Devnet test configuration — addresses for off-chain test artifacts
 * that live on devnet but aren't part of the program itself.
 *
 * These are NOT secrets. The mint authority is the local CLI wallet
 * (~/.config/solana/id.json) and the test mint is freely mintable to
 * any account by anyone holding that authority key.
 */

import type { Address } from "@solana/kit";

/**
 * Test $FLIP mint on devnet.
 * - Decimals: 9
 * - Mint authority: local CLI wallet (3XXMLDEf2DDdmgR978U8T5GhFLnxDNDUcJ2ETDw2bUWp)
 * - Created: 2026-04-10 (Task 3.A.2 setup)
 * - Tx: THKNzjc1p5RE7wgiy7iaxLXiG8kfcRJQJUYg59kdjssckPsSZqfBRhPkJ4czpWg4qMrCUA238vxrtnyY1xZfaM9
 *
 * If this mint is closed or revoked, regenerate with:
 *   spl-token create-token --decimals 9
 * and update the address below.
 */
export const TEST_FLIP_MINT =
  "2KqqB7SRVaD98ZbVaiRWirxbaJv5ryNzkDRGweBZVryF" as Address;
