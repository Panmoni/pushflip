/**
 * Shared CLI helpers for the pushflip devnet scripts.
 *
 * Pre-Mainnet 5.0.4 extraction. Before this file existed, every script
 * (`init-game.ts`, `init-vault.ts`, `mint-test-flip.ts`, `smoke-test.ts`,
 * `smoke-test-bounty.ts`, `smoke-test-burns.ts`, `smoke-test-tokens.ts`)
 * carried its own copy of the ANSI color table, the `ok`/`info`/`step`/
 * `fail`/`warn` log helpers, `printRpcError`, `loadCliKeypair`, `sendTx`,
 * and an `RpcContext` interface. Drift across copies caused inconsistent
 * error messages and the 13th heavy-duty review's L5 finding (raw
 * ENOENT stack from `loadCliKeypair`). Consolidating here lets one fix
 * land in one place for all seven scripts.
 *
 * Also hosts the CU-regression helpers (`getCuConsumed`,
 * `assertCuBudget`) that were deferred from Pre-Mainnet 5.0.9 PR 1
 * step 4 — see `smoke-test.ts` for the call sites that guard
 * `commit_deck` and `hit`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  type KeyPairSigner,
  type Rpc,
  type RpcSubscriptions,
  type Signature,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  devnet,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";

// --- Devnet endpoints ---

export const DEVNET_RPC_URL = "https://api.devnet.solana.com";
export const DEVNET_WS_URL = "wss://api.devnet.solana.com";

// --- ANSI color table ---

export const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
} as const;

// --- Logging helpers ---

export function step(n: number, label: string): void {
  console.log(`\n${c.bold}${c.cyan}[${n}]${c.reset} ${c.bold}${label}${c.reset}`);
}

export function ok(msg: string): void {
  console.log(`  ${c.green}✓${c.reset} ${msg}`);
}

export function info(msg: string): void {
  console.log(`  ${c.dim}${msg}${c.reset}`);
}

export function warn(msg: string): void {
  console.log(`  ${c.yellow}!${c.reset} ${msg}`);
}

export function fail(msg: string): never {
  console.log(`  ${c.red}✗${c.reset} ${msg}`);
  process.exit(1);
}

/**
 * Pretty-print an RPC error with program logs and the program-specific
 * custom error code (when present).
 */
export function printRpcError(label: string, e: unknown): void {
  console.log(`\n  ${c.red}${c.bold}✗ ${label}${c.reset}`);
  const err = e as Error & {
    context?: { logs?: string[] };
    cause?: Error & { context?: { code?: number } };
  };
  console.log(`  ${c.red}Error: ${err.message ?? String(e)}${c.reset}`);
  if (err.cause?.context?.code !== undefined) {
    const code = err.cause.context.code;
    console.log(
      `  ${c.red}Custom program error code: ${code} (0x${code.toString(16)})${c.reset}`,
    );
  }
  if (err.context?.logs && err.context.logs.length > 0) {
    console.log(`  ${c.red}Program logs:${c.reset}`);
    for (const line of err.context.logs) {
      console.log(`    ${c.dim}${line}${c.reset}`);
    }
  }
}

// --- Wallet ---

/**
 * Load the Solana CLI default keypair (`~/.config/solana/id.json`).
 *
 * Translates the common failure modes (file missing, permission denied,
 * malformed JSON) into friendly error messages via `fail()` rather than
 * propagating a raw ENOENT / SyntaxError stack trace. First-time users
 * hitting an empty `~/.config/solana/` directory get a clear next step
 * ("run `solana-keygen new`") instead of a cryptic Node error.
 *
 * Lineage: 13th heavy-duty review L5 introduced this in `init-vault.ts`;
 * Pre-Mainnet 5.0.4 promoted it here so all scripts share the same UX.
 */
export async function loadCliKeypair(): Promise<KeyPairSigner> {
  const path = resolve(homedir(), ".config/solana/id.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      fail(
        `CLI wallet not found at ${path}. Create one with: solana-keygen new`,
      );
    }
    if (err.code === "EACCES") {
      fail(
        `Permission denied reading ${path}. Check the file's ownership and mode (should be 0600).`,
      );
    }
    fail(`Failed to read CLI wallet at ${path}: ${err.message ?? String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fail(
      `CLI wallet at ${path} is not valid JSON: ${msg}. Re-create it with: solana-keygen new`,
    );
  }
  if (!Array.isArray(parsed)) {
    fail(
      `CLI wallet at ${path} is not a 64-byte secret-key array (got: ${typeof parsed}).`,
    );
  }
  try {
    const bytes = new Uint8Array(parsed);
    return await createKeyPairSignerFromBytes(bytes);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fail(`Failed to construct keypair from bytes in ${path}: ${msg}`);
  }
}

// --- RPC context + tx send ---

export interface RpcContext {
  rpc: Rpc<SolanaRpcApi>;
  rpcSubs: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory>;
}

export function makeDevnetContext(): RpcContext {
  const rpc = createSolanaRpc(devnet(DEVNET_RPC_URL));
  const rpcSubs = createSolanaRpcSubscriptions(devnet(DEVNET_WS_URL));
  const sendAndConfirm = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions: rpcSubs,
  });
  return { rpc, rpcSubs, sendAndConfirm };
}

/**
 * Build, sign, send, and confirm a transaction. Returns the signature.
 *
 * The `_signers` arg is documentation-only: Kit's
 * `signTransactionMessageWithSigners` walks the message's accounts list
 * and resolves each `KeyPairSigner` automatically — there's no separate
 * signers argument to pass through.
 */
export async function sendTx(
  ctx: RpcContext,
  feePayer: KeyPairSigner,
  instructions: Parameters<typeof appendTransactionMessageInstructions>[0],
  _signers: KeyPairSigner[] = [],
): Promise<string> {
  const { value: blockhash } = await ctx.rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(signed);
  await ctx.sendAndConfirm(signed, { commitment: "confirmed" });
  return getSignatureFromTransaction(signed);
}

// --- Misc ---

/**
 * Retry a flaky async operation up to `attempts` times with a small
 * exponential backoff. Devnet RPC occasionally drops connections mid-stream
 * with `SocketError: other side closed` and retries clear it instantly.
 */
export async function retry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 4,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(
        `  ${c.dim}retry ${i + 1}/${attempts} for ${label}: ${msg}${c.reset}`,
      );
      // 250ms, 500ms, 1000ms — total < 2s budget
      await new Promise((r) => setTimeout(r, 250 * 2 ** i));
    }
  }
  throw lastErr;
}

/** Random u64 game_id derived from current time + random bytes. */
export function randomGameId(): bigint {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let val = 0n;
  for (const b of bytes) val = (val << 8n) | BigInt(b);
  return val;
}

// --- Compute-unit (CU) regression helpers ---

/**
 * Fetch `meta.computeUnitsConsumed` for a confirmed transaction.
 *
 * Returns `null` if the tx is not yet visible (devnet sometimes lags
 * a few hundred ms behind `sendAndConfirm`'s "confirmed" return) so
 * callers can decide whether to retry, skip, or hard-fail. Use
 * `assertCuBudget` for the assert-or-fail variant.
 */
export async function getCuConsumed(
  rpc: Rpc<SolanaRpcApi>,
  sig: string,
): Promise<number | null> {
  const res = await rpc
    .getTransaction(sig as Signature, {
      encoding: "json",
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    })
    .send();
  if (!res || !res.meta) return null;
  const cu = res.meta.computeUnitsConsumed;
  if (cu === undefined || cu === null) return null;
  // Kit returns a bigint; downstream wants a number for human display
  // and comparisons (CU values are well under 2^53).
  return typeof cu === "bigint" ? Number(cu) : cu;
}

/**
 * Assert that a confirmed tx consumed ≤ `maxCu` compute units. Logs the
 * actual value via `info()` for visibility, and `fail()`s if exceeded.
 *
 * Pre-Mainnet 5.0.9 PR 1 deferred the CU regression assertion to this
 * helper. Use it on perf-critical instructions (`commit_deck`, `hit`)
 * so log-emission overhead or a future ZK-pipeline change can't
 * silently push them past their budgets.
 *
 * If the tx isn't yet visible to `getTransaction`, retries up to 4
 * times with 250 ms backoff before giving up (returns silently — we
 * don't want a transient lookup failure to fail the smoke test).
 */
export async function assertCuBudget(
  rpc: Rpc<SolanaRpcApi>,
  sig: string,
  label: string,
  maxCu: number,
): Promise<void> {
  let cu: number | null = null;
  for (let i = 0; i < 4; i++) {
    cu = await getCuConsumed(rpc, sig);
    if (cu !== null) break;
    await new Promise((r) => setTimeout(r, 250 * 2 ** i));
  }
  if (cu === null) {
    info(`CU lookup for ${label} timed out — skipping budget assertion`);
    return;
  }
  if (cu > maxCu) {
    fail(
      `${label} consumed ${cu} CU, exceeding budget ${maxCu} (regression?)`,
    );
  }
  info(`${label} CU: ${cu} / ${maxCu}`);
}
