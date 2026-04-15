/**
 * Mint test $FLIP to a recipient wallet on devnet.
 *
 * This is the **CLI faucet** for the test mint at
 * `2KqqB7SRVaD98ZbVaiRWirxbaJv5ryNzkDRGweBZVryF`. The mint authority
 * is the local CLI wallet (`~/.config/solana/id.json`), so anyone
 * holding that key can run this script to mint test FLIP to any
 * arbitrary recipient address.
 *
 * **Why this exists**: the JoinGameDialog blocks the "Join game"
 * button when the connected wallet has no $FLIP ATA. To unblock a
 * tester, the mint authority needs to send them some test FLIP.
 * Until a real faucet service exists (see EXECUTION_PLAN.md
 * Pre-Mainnet 5.0.7 — self-service test-FLIP faucet), this is the
 * manual path.
 *
 * Run with:
 *   pnpm --filter @pushflip/scripts mint-test-flip --to <BASE58>
 *   pnpm --filter @pushflip/scripts mint-test-flip --to <BASE58> --amount 500
 *
 * Defaults:
 *   --amount: 1000 (whole $FLIP, scaled by 10^9 internally)
 *
 * Idempotent: re-runs are safe. The ATA-create instruction uses
 * `getCreateAssociatedTokenIdempotentInstructionAsync` which is a
 * no-op if the ATA already exists; the mint instruction always
 * succeeds against an existing ATA.
 */

import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToInstruction,
} from "@solana-program/token";
import {
  type Address,
  address as toAddress,
} from "@solana/kit";

import { parseU64, U64_MAX } from "@pushflip/client";

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
} from "./lib/script-helpers";

// --- Config ---

/** Decimals on the $FLIP test mint. Mirrors `FLIP_DECIMALS` in @pushflip/client. */
const FLIP_DECIMALS = 9;
const FLIP_SCALE = 10n ** BigInt(FLIP_DECIMALS);

/** Default whole-$FLIP amount if `--amount` is not passed. */
const DEFAULT_AMOUNT_WHOLE = 1000n;

/** SPL Token program ID — hardcoded to avoid pulling @pushflip/client just for the constant. */
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

// --- CLI argument parsing ---

interface CliArgs {
  recipient: Address;
  amountWhole: bigint;
}

/**
 * Parse `--to <address>` and `--amount <whole-flip>` from `process.argv`.
 *
 * Validation:
 *   - `--to` is required and must be a valid base58 Solana address.
 *     `address(...)` from @solana/kit will throw on a malformed input.
 *   - `--amount` is optional, defaults to `DEFAULT_AMOUNT_WHOLE`. Parsed
 *     via the shared `@pushflip/client::parseU64` which rejects hex,
 *     negatives, decimals, scientific notation, and values that would
 *     overflow u64. This is the single source of truth for u64 input
 *     parsing across the monorepo — see `clients/js/src/bytes.ts`.
 */
function parseCliArgs(argv: string[]): CliArgs {
  let recipientRaw: string | null = null;
  let amountRaw: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--to") {
      recipientRaw = argv[i + 1] ?? null;
      i++;
    } else if (arg === "--amount") {
      amountRaw = argv[i + 1] ?? null;
      i++;
    } else if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    }
  }

  if (!recipientRaw) {
    printUsage();
    fail("Missing required --to <address>");
  }

  let recipient: Address;
  try {
    recipient = toAddress(recipientRaw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fail(`Invalid recipient address: ${recipientRaw} (${msg})`);
  }

  let amountWhole = DEFAULT_AMOUNT_WHOLE;
  if (amountRaw !== null) {
    try {
      amountWhole = parseU64(amountRaw, "--amount");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      fail(msg);
    }
    if (amountWhole === 0n) {
      fail("Refusing to mint 0 $FLIP — pass a positive amount");
    }
  }

  return { recipient, amountWhole };
}

function printUsage(): void {
  console.log(`Usage: pnpm --filter @pushflip/scripts mint-test-flip --to <BASE58> [--amount <whole-flip>]

Mints test $FLIP from the test mint to a recipient wallet on devnet.
The mint authority is the local CLI wallet at ~/.config/solana/id.json.

Options:
  --to <BASE58>         Recipient wallet address (required)
  --amount <whole-flip> Amount in WHOLE $FLIP (default: ${DEFAULT_AMOUNT_WHOLE})
  -h, --help            Show this help

Examples:
  pnpm --filter @pushflip/scripts mint-test-flip --to AczLp...MDjH
  pnpm --filter @pushflip/scripts mint-test-flip --to AczLp...MDjH --amount 500
`);
}

// --- Main ---

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  // `parseU64` validated `args.amountWhole <= u64::MAX`, but the conversion
  // from whole-FLIP to base units multiplies by `FLIP_SCALE = 10^9`, which
  // can push the product above u64::MAX even when the input was valid.
  // The SPL `MintTo` instruction encodes its `amount` field as a little-
  // endian u64; if we handed `setBigUint64` a bigint above u64::MAX it
  // would silently wrap (Lesson #42). Cap here before it reaches the wire.
  const amountBaseUnits = args.amountWhole * FLIP_SCALE;
  if (amountBaseUnits > U64_MAX) {
    fail(
      `--amount ${args.amountWhole} scaled to ${amountBaseUnits} base units exceeds u64 max (${U64_MAX}) — max mintable is ${
        U64_MAX / FLIP_SCALE
      } whole $FLIP`,
    );
  }

  console.log(
    `${c.bold}${c.blue}╔════════════════════════════════════════════════════╗${c.reset}`,
  );
  console.log(
    `${c.bold}${c.blue}║  PushFlip — Mint test $FLIP                        ║${c.reset}`,
  );
  console.log(
    `${c.bold}${c.blue}╚════════════════════════════════════════════════════╝${c.reset}`,
  );
  console.log(`${c.dim}Mint:      ${TEST_FLIP_MINT}${c.reset}`);
  console.log(`${c.dim}Recipient: ${args.recipient}${c.reset}`);
  console.log(`${c.dim}Amount:    ${args.amountWhole.toString()} $FLIP (${amountBaseUnits.toString()} base units)${c.reset}`);
  console.log(`${c.dim}Cluster:   devnet${c.reset}`);

  const ctx: RpcContext = makeDevnetContext();

  // --- Load mint authority ---
  step(0, "Load CLI wallet (mint authority)");
  const wallet = await loadCliKeypair();
  ok(`Authority: ${wallet.address}`);

  // --- Derive recipient ATA ---
  step(1, "Derive recipient associated token account");
  const [recipientAta] = await findAssociatedTokenPda({
    mint: TEST_FLIP_MINT,
    owner: args.recipient,
    tokenProgram: TOKEN_PROGRAM_ID,
  });
  info(`ATA: ${recipientAta}`);

  // --- Create ATA + mint in one transaction ---
  step(2, "Create ATA (idempotent) + mint");
  const createAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer: wallet,
    owner: args.recipient,
    mint: TEST_FLIP_MINT,
  });
  const mintIx = getMintToInstruction({
    mint: TEST_FLIP_MINT,
    token: recipientAta,
    mintAuthority: wallet,
    amount: amountBaseUnits,
  });

  let sig: string;
  try {
    sig = await sendTx(ctx, wallet, [createAtaIx, mintIx]);
  } catch (e) {
    printRpcError("Mint failed", e);
    process.exit(2);
  }
  ok("Mint confirmed");
  info(`tx: ${sig}`);
  info(`https://explorer.solana.com/tx/${sig}?cluster=devnet`);

  console.log(
    `\n${c.green}${c.bold}✓ Done.${c.reset} Minted ${args.amountWhole.toString()} $FLIP to ${args.recipient}\n`,
  );
}

main()
  .then(() => process.exit(0)) // force-exit so an open WSS handle doesn't keep us alive (mirrors smoke-test.ts:735)
  .catch((err) => {
    console.error(`\n${c.red}${c.bold}✗ mint-test-flip failed:${c.reset}`, err);
    process.exit(1);
  });
