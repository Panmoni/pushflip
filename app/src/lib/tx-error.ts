/**
 * Transaction error helpers shared by the wallet bridge and the action
 * hooks. Centralizes:
 *
 *  - `TransactionSimulationError` — a structured error class that carries
 *    program logs + a human hint through `runAction` so the toast can
 *    render something actionable instead of the opaque RPC payload.
 *  - `extractProgramLogs` — best-effort parse of Solana RPC error
 *    payloads to pull out `program log:` lines so we can surface the
 *    on-chain program's own output to the user.
 *  - `isWalletClusterMismatch` — detect Phantom's "reverted during
 *    simulation" error message, which in practice means the wallet's
 *    internal simulation RPC is pointed at a cluster where the pushflip
 *    program does not exist (usually mainnet). Because Phantom has no
 *    programmatic API to switch clusters, this is the cheapest way to
 *    turn a confusing generic error into a specific user-actionable one.
 *
 * **Why this file exists separate from `wallet-bridge.ts`**: the bridge
 * is framework-agnostic (no React, no toasts). This module holds the
 * policy decisions (what counts as "cluster mismatch", how to format
 * the message for humans) that the bridge throws AND that the UI layer
 * consumes when rendering toasts.
 */

/**
 * Structured error raised by the wallet bridge when a transaction
 * fails either at app-side pre-simulation OR at wallet-side signing.
 *
 * `kind` distinguishes which stage failed:
 *   - "app-simulation"   — our own `simulateTransaction` call against
 *                          the Kit RPC returned `err: { ... }`. The
 *                          transaction is broken before the wallet ever
 *                          sees it. Logs come from the RPC response.
 *   - "wallet-simulation" — the wallet adapter's `signTransaction`
 *                          threw with a message that looks like a
 *                          simulation failure. Logs are unavailable
 *                          (the wallet doesn't expose them).
 *   - "send"              — `sendAndConfirmTransaction` failed AFTER
 *                          the wallet signed. Usually a blockhash
 *                          expiry or a 45s timeout. Logs may be
 *                          available via `rawError`.
 *
 * `humanHint` is a short actionable sentence to display alongside the
 * raw message — e.g. "Check your wallet is set to Solana Devnet".
 */
export class TransactionSimulationError extends Error {
  readonly kind: "app-simulation" | "wallet-simulation" | "send";
  readonly logs: readonly string[];
  readonly humanHint: string | null;
  readonly rawError: unknown;

  constructor(params: {
    kind: "app-simulation" | "wallet-simulation" | "send";
    message: string;
    logs?: readonly string[];
    humanHint?: string | null;
    rawError?: unknown;
  }) {
    super(params.message);
    this.name = "TransactionSimulationError";
    this.kind = params.kind;
    this.logs = params.logs ?? [];
    this.humanHint = params.humanHint ?? null;
    this.rawError = params.rawError;
  }
}

const CLUSTER_MISMATCH_HINT =
  "Your wallet may be on the wrong cluster. Pushflip is devnet-only — " +
  "in Phantom: Settings → Developer Settings → Testnet Mode → Solana Devnet.";

// Patterns Phantom uses when its internal simulation rejects a tx.
// The exact string shows up in `error.message` on the rejection from
// `signTransaction`. Keep this list tight — we only want to remap
// errors that unambiguously point at the wallet's own simulation.
const WALLET_SIMULATION_REJECTION_PATTERNS = [
  /reverted during simulation/i,
  /funds may be lost if submitted/i,
];

/**
 * Recognize the set of wallet-side error shapes that in practice mean
 * "the wallet's internal simulation failed, almost certainly because
 * the wallet is on a different cluster than our RPC". Used by the
 * wallet bridge to swap a confusing generic error for an actionable
 * cluster-mismatch hint.
 */
export function isWalletClusterMismatch(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const haystack = `${error.message} ${error.name}`.toLowerCase();
  return WALLET_SIMULATION_REJECTION_PATTERNS.some((pattern) =>
    pattern.test(haystack)
  );
}

/** Short human hint for cluster mismatch. Exported so the banner can reuse it. */
export const CLUSTER_MISMATCH_MESSAGE = CLUSTER_MISMATCH_HINT;

/**
 * Best-effort extraction of `program log:` lines from a Solana RPC
 * simulation response. Accepts the raw `simulateTransaction` result
 * shape OR a thrown `SolanaError` with a `.context.logs` property.
 *
 * Returns an empty array if no logs can be found. Never throws.
 */
export function extractProgramLogs(source: unknown): readonly string[] {
  if (!source || typeof source !== "object") {
    return [];
  }
  // Shape 1: raw simulateTransaction response — `{ value: { logs: [...] } }`.
  const maybeValue = (source as { value?: unknown }).value;
  if (maybeValue && typeof maybeValue === "object") {
    const logs = (maybeValue as { logs?: unknown }).logs;
    if (Array.isArray(logs)) {
      return logs.filter((l): l is string => typeof l === "string");
    }
  }
  // Shape 2: SolanaError thrown from send — `.context.logs`.
  const maybeContext = (source as { context?: unknown }).context;
  if (maybeContext && typeof maybeContext === "object") {
    const logs = (maybeContext as { logs?: unknown }).logs;
    if (Array.isArray(logs)) {
      return logs.filter((l): l is string => typeof l === "string");
    }
  }
  return [];
}

/**
 * Regex matching Solana program-log lines that carry the actual
 * failure signal — "Custom program error: 0x...", "Program X failed:
 * ...", or "Program log: error: ...". Hoisted to module scope per
 * biome's `useTopLevelRegex` rule.
 *
 * Log ordering in a failed Solana tx typically looks like:
 *   [0] Program HQLe... invoke [1]
 *   [1] Program log: Instruction: JoinRound
 *   [2] Program log: Custom program error: 0x6
 *   [3] Program HQLe... consumed 2080 of 200000 compute units
 *   [4] Program HQLe... failed: custom program error: 0x6
 *
 * A naive `logs.slice(-2)` captures lines [3]+[4]. The error code
 * IS in line [4], but putting the compute-unit line first buries
 * the useful info on the left of the toast. For multi-CPI
 * transactions the problem is worse — inner-program compute-unit
 * tails can push the top-level error line off the visible window.
 */
const ERROR_LINE_RE = /custom program error|failed:|\berror:/i;

/**
 * Format a TransactionSimulationError as the single-line description
 * that the sonner toast expects. Combines the human hint (if any)
 * with the most relevant one or two program-log lines, preferring
 * lines that actually mention an error over compute-unit noise.
 * Keeps the total string under ~220 characters so it doesn't blow
 * out the toast.
 */
export function formatTxErrorDescription(
  err: TransactionSimulationError
): string {
  const parts: string[] = [];
  if (err.humanHint) {
    parts.push(err.humanHint);
  }
  if (err.logs.length > 0) {
    // Content-aware selection: prefer lines that look like an error
    // over whatever happens to be at the tail of the log stream.
    // Fall back to the last two lines only when no error-shaped
    // line exists (e.g. the tx ran to success but something else
    // failed, or the program emits its errors non-standardly).
    const errorLines = err.logs.filter((line) => ERROR_LINE_RE.test(line));
    const pickedLines =
      errorLines.length > 0 ? errorLines.slice(-2) : err.logs.slice(-2);
    parts.push(pickedLines.join(" · "));
  }
  if (parts.length === 0) {
    parts.push(err.message);
  }
  const joined = parts.join(" — ");
  return joined.length > 220 ? `${joined.slice(0, 217)}…` : joined;
}
