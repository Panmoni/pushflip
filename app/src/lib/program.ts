/**
 * Kit RPC client construction.
 *
 * Centralizes the @solana/kit RPC + RPC subscriptions clients so every hook
 * and component imports the same instances. Instruction builders, PDA
 * derivers, and account decoders are imported directly from the
 * `@pushflip/client` workspace package — no barrel re-export here, since
 * `@pushflip/client` is already the workspace seam between app/ and the
 * hand-written program client.
 *
 * Per CONTRIBUTING.md conventions, we do NOT use Codama-generated clients —
 * Pinocchio's manual byte layouts are mirrored directly in @pushflip/client.
 */

import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  devnet,
  type RpcDevnet,
  type RpcSubscriptionsDevnet,
  type SolanaRpcApiDevnet,
  type SolanaRpcSubscriptionsApi,
} from "@solana/kit";

import { RPC_ENDPOINT, RPC_WS_ENDPOINT } from "./constants";

/*
 * HMR safety: this module constructs long-lived RPC + WebSocket clients at
 * import time. Without `import.meta.hot.invalidate()`, Vite's HMR will
 * re-evaluate this module on edit and leak the old WebSocket from
 * `rpcSubscriptions` while opening a new one. Forcing a full reload here
 * keeps the dev session WebSocket count bounded. No-op in production.
 */
if (import.meta.hot) {
  import.meta.hot.invalidate();
}

/**
 * Devnet-typed Kit RPC client. Use for all on-chain reads/writes.
 *
 * The explicit `RpcDevnet<SolanaRpcApiDevnet>` annotation preserves Kit's
 * cluster-narrowed type so calls to devnet-only methods (`requestAirdrop`,
 * `getStakeMinimumDelegation`, etc.) remain compile-checked. Dropping it
 * would widen to `Rpc<SolanaRpcApi>` and silently allow mainnet-incompatible
 * code paths.
 *
 * Note: this is SEPARATE from the `Connection` instance the wallet adapter's
 * `ConnectionProvider` constructs internally. The wallet adapter still uses
 * web3.js v1 under the hood; we use Kit for everything we control. The
 * bridge between the two lives at action call sites via `@solana/compat`'s
 * `fromLegacyPublicKey` / `fromLegacyTransactionInstruction`.
 */
export const rpc: RpcDevnet<SolanaRpcApiDevnet> = createSolanaRpc(
  devnet(RPC_ENDPOINT)
);

/**
 * Devnet-typed Kit RPC subscriptions client. Use for `accountNotifications`,
 * `signatureNotifications`, and `logsNotifications` in hooks.
 */
export const rpcSubscriptions: RpcSubscriptionsDevnet<SolanaRpcSubscriptionsApi> =
  createSolanaRpcSubscriptions(devnet(RPC_WS_ENDPOINT));
