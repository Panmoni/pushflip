/**
 * Initialize the SPL token account at the vault PDA for an existing
 * GameSession on devnet. This flips the game from `vault_ready=false`
 * (test mode — `joinRound` skips the token transfer and stakes 0) to
 * `vault_ready=true` (real mode — `joinRound` performs an actual SPL
 * Token transfer from the player's ATA to the vault on every join).
 *
 * **Why this exists**: `initialize` records the vault PDA address in
 * the GameSession but does NOT create an SPL token account at that
 * address (only the program itself can sign for its own PDAs). The
 * `init_vault` instruction signs with the vault PDA seeds and CPIs
 * `system::create_account` + `spl_token::initialize_account_3` to
 * place a token account there owned by the vault PDA itself. See
 * the program docstring at `program/src/instructions/init_vault.rs`.
 *
 * **IRREVERSIBLE**: there is no `close_vault` instruction. Once a
 * vault is initialized, the game is permanently in real-stake mode.
 * The program also enforces (heavy-duty review #5 H1) that only the
 * game's authority may call `init_vault`, so a griefer can't flip
 * someone else's game without consent.
 *
 * Run with:
 *   pnpm --filter @pushflip/scripts init-vault             # game_id=1
 *   GAME_ID=2 pnpm --filter @pushflip/scripts init-vault   # different id
 *
 * Idempotent: re-runs against an already-initialized vault print the
 * existing state and exit 0 without re-sending.
 */

import {
  type Rpc,
  type RpcSubscriptions,
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
  type KeyPairSigner,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import {
  decodeGameSession,
  deriveGamePda,
  deriveVaultPda,
  getInitVaultInstruction,
  parseU64,
  PUSHFLIP_PROGRAM_ID,
} from "@pushflip/client";

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { TEST_FLIP_MINT } from "./devnet-config.js";

// --- Config ---

const DEVNET_RPC_URL = "https://api.devnet.solana.com";
const DEVNET_WS_URL = "wss://api.devnet.solana.com";

// `game_id` is u64. Default 1n to match `app/src/lib/constants.ts:62`.
const GAME_ID: bigint = (() => {
  const raw = process.env.GAME_ID?.trim();
  if (!raw) return 1n;
  return parseU64(raw, "GAME_ID env var");
})();

// --- Tiny logging helpers (mirror init-game.ts style) ---

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function ok(msg: string): void {
  console.log(`  ${c.green}✓${c.reset} ${msg}`);
}
function info(msg: string): void {
  console.log(`  ${c.dim}${msg}${c.reset}`);
}
function step(n: number, label: string): void {
  console.log(`\n${c.bold}${c.cyan}[${n}]${c.reset} ${c.bold}${label}${c.reset}`);
}
function fail(msg: string): never {
  console.log(`  ${c.red}✗${c.reset} ${msg}`);
  process.exit(1);
}
function warn(msg: string): void {
  console.log(`  ${c.yellow}!${c.reset} ${msg}`);
}

function printRpcError(label: string, e: unknown): void {
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

// --- Wallet loading ---

/**
 * Load the CLI keypair from `~/.config/solana/id.json`.
 *
 * Translates the common failure modes (file missing, permission denied,
 * malformed JSON) into friendly error messages via `fail()` rather than
 * propagating a raw ENOENT / SyntaxError stack trace. First-time users
 * hitting an empty `~/.config/solana/` directory get a clear next step
 * ("run `solana-keygen new`") instead of a cryptic Node error.
 *
 * 13th heavy-duty review L5. Same UX improvement belongs in `init-game.ts`
 * and `mint-test-flip.ts`; tracked for the Pre-Mainnet 5.0.4
 * `scripts/lib/script-helpers.ts` extraction where this helper becomes
 * shared across all three scripts.
 */
async function loadCliKeypair(): Promise<KeyPairSigner> {
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

interface RpcContext {
  rpc: Rpc<SolanaRpcApi>;
  rpcSubs: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory>;
}

async function sendTx(
  ctx: RpcContext,
  feePayer: KeyPairSigner,
  instructions: Parameters<typeof appendTransactionMessageInstructions>[0],
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

// --- Main ---

async function main(): Promise<void> {
  console.log(
    `${c.bold}${c.blue}╔════════════════════════════════════════════════════╗${c.reset}`,
  );
  console.log(
    `${c.bold}${c.blue}║  PushFlip — Initialize vault (game_id=${GAME_ID
      .toString()
      .padEnd(5)})           ║${c.reset}`,
  );
  console.log(
    `${c.bold}${c.blue}╚════════════════════════════════════════════════════╝${c.reset}`,
  );
  console.log(`${c.dim}Program: ${PUSHFLIP_PROGRAM_ID}${c.reset}`);
  console.log(`${c.dim}Cluster: devnet${c.reset}`);
  console.log(`${c.dim}Token mint: ${TEST_FLIP_MINT}${c.reset}`);
  console.log();
  console.log(
    `  ${c.yellow}!${c.reset} ${c.yellow}IRREVERSIBLE${c.reset}: once the vault is initialized, the game is`,
  );
  console.log(
    `    permanently in real-stake mode. Future joins will require an`,
  );
  console.log(`    actual SPL Token transfer from the player's ATA.`);

  const rpc = createSolanaRpc(devnet(DEVNET_RPC_URL));
  const rpcSubs = createSolanaRpcSubscriptions(devnet(DEVNET_WS_URL));
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: rpcSubs });
  const ctx: RpcContext = { rpc, rpcSubs, sendAndConfirm };

  // --- Load wallet ---
  step(0, "Load CLI wallet (must be the game authority)");
  const wallet = await loadCliKeypair();
  ok(`Wallet: ${wallet.address}`);

  // --- Derive PDAs ---
  step(1, "Derive PDAs");
  const [gamePda, gameBump] = await deriveGamePda(GAME_ID);
  const [vaultPda, vaultBump] = await deriveVaultPda(gamePda);
  info(`game_id:     ${GAME_ID}`);
  info(`game PDA:    ${gamePda} (bump ${gameBump})`);
  info(`vault PDA:   ${vaultPda} (bump ${vaultBump})`);

  // --- Validate game exists + we're the authority + token_mint matches ---
  step(2, "Verify game state and authority");
  const existing = await rpc.getAccountInfo(gamePda, { encoding: "base64" }).send();
  if (!existing.value) {
    fail(
      `GameSession at ${gamePda} does not exist. Run init-game first: pnpm --filter @pushflip/scripts init-game`,
    );
  }
  // Defense-in-depth: verify the account is owned by the pushflip program
  // BEFORE handing it to `decodeGameSession`. The decoder only checks the
  // discriminator byte, so a non-pushflip account with a collision on the
  // first byte would decode to garbage that happens to pass the type system.
  // The on-chain program also validates ownership, but bailing here gives a
  // much clearer error than "failed: custom program error: 0x..." after a
  // wasted round-trip. 13th heavy-duty review L3.
  if (existing.value.owner !== PUSHFLIP_PROGRAM_ID) {
    fail(
      `Account at ${gamePda} is owned by ${existing.value.owner}, not the pushflip program (${PUSHFLIP_PROGRAM_ID}). Refusing to decode.`,
    );
  }
  const gs = decodeGameSession(Buffer.from(existing.value.data[0], "base64"));
  info(`authority:    ${gs.authority}`);
  info(`tokenMint:    ${gs.tokenMint}`);
  info(`vault stored: ${gs.vault}`);
  info(`playerCount:  ${gs.playerCount}`);
  info(`roundActive:  ${gs.roundActive}`);

  if (gs.authority !== wallet.address) {
    fail(
      `Wallet ${wallet.address} is NOT the game authority (${gs.authority}). Only the game authority may initialize the vault.`,
    );
  }
  ok("Wallet is the game authority");

  if (gs.tokenMint !== TEST_FLIP_MINT) {
    fail(
      `Game token_mint (${gs.tokenMint}) does not match TEST_FLIP_MINT (${TEST_FLIP_MINT}). Refusing to proceed against an unexpected mint.`,
    );
  }
  ok("Token mint matches devnet test mint");

  if (gs.vault !== vaultPda) {
    fail(
      `Game stored vault (${gs.vault}) does not match derived vault PDA (${vaultPda}) — derivation drift?`,
    );
  }
  ok("Vault PDA matches game's stored vault address");

  // --- Idempotency check ---
  step(3, "Check if vault already exists on-chain");
  const vaultAcc = await rpc.getAccountInfo(vaultPda, { encoding: "base64" }).send();
  // Mirror the on-chain `init_vault` check exactly: the program refuses
  // re-init if `vault.data_len() > 0`, NOT if the account merely exists
  // (init_vault.rs:129). A 0-byte account at the vault PDA is structurally
  // impossible today (only the pushflip program can sign for the vault
  // seeds, and it only creates 165-byte token accounts there), but
  // mirroring the program's check verbatim is free defensive correctness
  // and protects against future program-side relaxations. 13th review L4.
  const vaultDataLen = vaultAcc.value
    ? Buffer.from(vaultAcc.value.data[0], "base64").length
    : 0;
  if (vaultAcc.value && vaultDataLen > 0) {
    ok(
      `Vault already initialized (data_len=${vaultDataLen}, owner=${vaultAcc.value.owner})`,
    );
    info("Nothing to do — `vault_ready=true` is already in effect for this game.");
    console.log(
      `\n${c.green}${c.bold}✓ Done.${c.reset} Game ${gamePda} is already in real-stake mode.\n`,
    );
    return;
  }
  info("Vault does not exist yet — initializing");

  // --- Send InitVault ---
  step(4, "Send InitVault instruction");
  warn("This is the irreversible step — flipping vault_ready=false → true.");
  const initVaultIx = getInitVaultInstruction({
    payer: wallet.address,
    gameSession: gamePda,
    vault: vaultPda,
    tokenMint: TEST_FLIP_MINT,
  });

  let sig: string;
  try {
    sig = await sendTx(ctx, wallet, [initVaultIx]);
  } catch (e) {
    printRpcError("InitVault failed", e);
    process.exit(2);
  }
  ok("InitVault confirmed");
  info(`tx: ${sig}`);
  info(`https://explorer.solana.com/tx/${sig}?cluster=devnet`);

  // --- Verify ---
  step(5, "Verify vault exists post-tx");
  const after = await rpc.getAccountInfo(vaultPda, { encoding: "base64" }).send();
  if (!after.value) {
    fail("Vault account not found after InitVault — this should never happen");
  }
  const dataLen = Buffer.from(after.value.data[0], "base64").length;
  ok(`Vault account exists (data_len=${dataLen}, owner=${after.value.owner})`);

  console.log(
    `\n${c.green}${c.bold}✓ Done.${c.reset} Vault for game ${gamePda} is initialized.`,
  );
  console.log(
    `${c.dim}Future \`joinRound\` calls against this game will perform real SPL Token transfers from the player's ATA to the vault.${c.reset}\n`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\n${c.red}${c.bold}✗ init-vault failed:${c.reset}`, err);
    process.exit(1);
  });
