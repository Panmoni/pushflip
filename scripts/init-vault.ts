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
  decodeGameSession,
  deriveGamePda,
  deriveVaultPda,
  getInitVaultInstruction,
  parseU64,
  PUSHFLIP_PROGRAM_ID,
} from "@pushflip/client";

import { TEST_FLIP_MINT } from "./devnet-config.js";

import {
  type RpcContext,
  c,
  fail,
  info,
  loadCliKeypair,
  makeDevnetContext,
  ok,
  printRpcError,
  sendTx,
  step,
  warn,
} from "./lib/script-helpers";

// --- Config ---

// `game_id` is u64. Default 1n to match `app/src/lib/constants.ts:62`.
const GAME_ID: bigint = (() => {
  const raw = process.env.GAME_ID?.trim();
  if (!raw) return 1n;
  return parseU64(raw, "GAME_ID env var");
})();

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

  const ctx: RpcContext = makeDevnetContext();
  const { rpc } = ctx;

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
