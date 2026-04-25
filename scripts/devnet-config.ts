/**
 * Devnet test configuration — addresses for off-chain test artifacts
 * that live on devnet but aren't part of the program itself.
 *
 * These are NOT secrets. The `$FLIP` mint authority was held by the
 * local CLI wallet until 2026-04-15, when it was transferred to a
 * dedicated faucet keypair (`5vzyxxJ1NwoN5PgX1p2zCavbxc7mugLMdF7At5syGfA6`)
 * for Pre-Mainnet 5.0.7. The local CLI wallet can no longer mint via
 * `scripts/mint-test-flip.ts` — that script is now an emergency tool
 * that only works if you also have the faucet keypair locally. Day-to-day
 * minting goes through the faucet service (faucet/).
 *
 * The canonical mint address lives in `@pushflip/client/constants.ts`
 * — this module re-exports it so existing imports keep working while
 * there is exactly one source of truth. (16th heavy-duty review M1 —
 * avoid drift across 3 copies.)
 */

export { TEST_FLIP_MINT } from "@pushflip/client";
