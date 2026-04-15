/**
 * Mint `$FLIP` to a recipient wallet. The faucet keypair is the fee
 * payer AND the mint authority — this is the key UX property:
 * brand-new wallets with 0 SOL can still receive tokens because the
 * faucet pays all fees.
 *
 * Mirrors `scripts/mint-test-flip.ts`: idempotent ATA creation (no-op
 * if the ATA already exists), then MintTo. The two instructions go in
 * one transaction so the user sees a single confirmed signature.
 */

import {
  FLIP_DECIMALS,
  TEST_FLIP_MINT,
  TOKEN_PROGRAM_ID,
  U64_MAX,
} from "@pushflip/client";
import {
  type Address,
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
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  address as toAddress,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToInstruction,
} from "@solana-program/token";

import { CONFIG, loadFaucetKeypairBytes } from "./config";

const FLIP_SCALE = 10n ** BigInt(FLIP_DECIMALS);

// Locally-named alias: server.ts + index.ts import this rather than
// re-exporting an imported symbol (which biome's `noExportedImports`
// flags as a style issue — hoist into a real binding instead).
export const FAUCET_MINT = TEST_FLIP_MINT;

export interface FaucetContext {
  authority: KeyPairSigner;
  rpc: Rpc<SolanaRpcApi>;
  rpcSubs: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory>;
}

/**
 * Build the faucet context once at startup. The keypair is loaded
 * eagerly (fail-fast on misconfiguration) and the RPC clients are
 * reused across requests.
 */
export async function createFaucetContext(): Promise<FaucetContext> {
  const rpc = createSolanaRpc(devnet(CONFIG.rpcEndpoint));
  const rpcSubs = createSolanaRpcSubscriptions(devnet(CONFIG.wsEndpoint));
  const sendAndConfirm = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions: rpcSubs,
  });
  const authority = await createKeyPairSignerFromBytes(
    loadFaucetKeypairBytes()
  );
  return { rpc, rpcSubs, sendAndConfirm, authority };
}

export interface MintResult {
  amountBaseUnits: bigint;
  recipientAta: Address;
  signature: string;
}

/**
 * Validate a recipient address (must be base58, must decode to a
 * 32-byte pubkey). Throws with a clean error message on invalid input.
 */
export function parseRecipient(raw: unknown): Address {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("recipient must be a non-empty string");
  }
  try {
    return toAddress(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`invalid recipient address: ${msg}`);
  }
}

/**
 * Mint `FAUCET_AMOUNT_WHOLE_FLIP` (scaled to base units) to the
 * recipient's ATA. The transaction:
 *   1. Creates the recipient's ATA if missing (idempotent)
 *   2. Mints the scaled amount to it
 *
 * Returns the confirmed signature + the ATA address + the minted
 * amount in base units (for telemetry and UI display).
 */
export async function mintToRecipient(
  ctx: FaucetContext,
  recipient: Address
): Promise<MintResult> {
  const amountBaseUnits = CONFIG.faucetAmountWhole * FLIP_SCALE;
  if (amountBaseUnits > U64_MAX) {
    // Defensive: config validation caps faucetAmountWhole well under
    // this, but the scale multiplication could theoretically overflow
    // for a misconfigured deployment. Same guard pattern as
    // scripts/mint-test-flip.ts (Lesson #42).
    throw new Error(
      `FAUCET_AMOUNT_WHOLE_FLIP (${CONFIG.faucetAmountWhole}) scaled to ${amountBaseUnits} base units exceeds u64::MAX. Lower FAUCET_AMOUNT_WHOLE_FLIP.`
    );
  }

  const [recipientAta] = await findAssociatedTokenPda({
    mint: TEST_FLIP_MINT,
    owner: recipient,
    tokenProgram: TOKEN_PROGRAM_ID,
  });

  const createAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer: ctx.authority,
    owner: recipient,
    mint: TEST_FLIP_MINT,
  });

  const mintIx = getMintToInstruction({
    mint: TEST_FLIP_MINT,
    token: recipientAta,
    mintAuthority: ctx.authority,
    amount: amountBaseUnits,
  });

  const { value: blockhash } = await ctx.rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(ctx.authority, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([createAtaIx, mintIx], m)
  );
  const signed = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(signed);
  await ctx.sendAndConfirm(signed, { commitment: "confirmed" });
  const signature = getSignatureFromTransaction(signed);

  return { signature, recipientAta, amountBaseUnits };
}
