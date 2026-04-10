/**
 * Wallet adapter ↔ Kit signing bridge.
 *
 * `@solana/wallet-adapter-react` returns a `signTransaction` function that
 * accepts web3.js v1 `VersionedTransaction` objects (the wallet adapter
 * ecosystem still uses web3.js v1 internally). Our hooks build transaction
 * messages with `@solana/kit`. This module is the seam:
 *
 *   1. Compile the Kit `TransactionMessage` to a Kit `Transaction` (which
 *      has wire-format `messageBytes`).
 *   2. Wrap those bytes as a web3.js `VersionedTransaction` so the wallet
 *      adapter can sign it.
 *   3. Take the signed result back through `@solana/compat`'s
 *      `fromVersionedTransaction` to get a Kit `Transaction` with the
 *      signatures filled in.
 *   4. Narrow the lifetime type with `assertIsTransactionWithBlockhashLifetime`
 *      (Kit 6 widened the union — see the smoke-test fix in scripts/).
 *   5. Send + confirm via Kit's `sendAndConfirmTransactionFactory`.
 *
 * The roundtrip is one-time per transaction and uses zero web3.js v1 logic
 * beyond the wire-format deserializer. As `@solana/wallet-adapter-react`
 * eventually grows native Kit support, this bridge can be replaced with a
 * direct `signTransactionMessageWithSigners` call.
 */

import { fromVersionedTransaction } from "@solana/compat";
import {
  assertIsSendableTransaction,
  assertIsTransactionWithBlockhashLifetime,
  compileTransaction,
  getSignatureFromTransaction,
  type Signature,
  sendAndConfirmTransactionFactory,
  type TransactionMessage,
  type TransactionMessageWithBlockhashLifetime,
  type TransactionMessageWithFeePayer,
} from "@solana/kit";
import { VersionedMessage, VersionedTransaction } from "@solana/web3.js";

import { rpc, rpcSubscriptions } from "./program";

/**
 * Shape of `useWallet().signTransaction` from `@solana/wallet-adapter-react`.
 *
 * The real type is `<T extends Transaction | VersionedTransaction>(tx: T) =>
 * Promise<T>`, but we only ever pass `VersionedTransaction` so we narrow.
 */
type WalletSignVersionedTransaction = (
  tx: VersionedTransaction
) => Promise<VersionedTransaction>;

/** Lazy-init so module load doesn't open the WSS connection unconditionally. */
let cachedSendAndConfirm: ReturnType<
  typeof sendAndConfirmTransactionFactory
> | null = null;

function getSendAndConfirm(): ReturnType<
  typeof sendAndConfirmTransactionFactory
> {
  if (!cachedSendAndConfirm) {
    cachedSendAndConfirm = sendAndConfirmTransactionFactory({
      rpc,
      rpcSubscriptions,
    });
  }
  return cachedSendAndConfirm;
}

/**
 * Sign a Kit transaction message via the wallet adapter and send it via
 * the Kit RPC client. Returns the base58 signature.
 */
export async function signAndSendKitMessage(
  message: TransactionMessage &
    TransactionMessageWithFeePayer &
    TransactionMessageWithBlockhashLifetime,
  walletSignTransaction: WalletSignVersionedTransaction
): Promise<Signature> {
  // 1. Compile the Kit message to wire-format bytes.
  const compiled = compileTransaction(message);
  const originalMessageBytes = new Uint8Array(compiled.messageBytes);

  // 2. Wrap the message bytes as a web3.js VersionedTransaction so the
  //    wallet adapter can recognize and sign it. `compiled.messageBytes`
  //    is a branded ReadonlyUint8Array; the copy above gives us a
  //    mutable Uint8Array for web3.js's deserializer AND a stable
  //    reference for the post-sign verification step below.
  const versionedTx = new VersionedTransaction(
    VersionedMessage.deserialize(originalMessageBytes)
  );

  // 3. Hand off to the wallet for the user to approve.
  const signedVersionedTx = await walletSignTransaction(versionedTx);

  // 4. Defense-in-depth: verify the wallet returned a transaction whose
  //    message bytes match what we asked it to sign. A buggy wallet
  //    adapter — or a malicious browser extension intercepting the wallet
  //    RPC — could swap the message body and have the user sign an
  //    attacker's transaction. Comparing the serialized message before
  //    accepting the signature catches both cases. Cheap (one serialize +
  //    one byte loop) and runs once per action.
  const signedMessageBytes = signedVersionedTx.message.serialize();
  if (signedMessageBytes.length !== originalMessageBytes.length) {
    throw new Error(
      "wallet-bridge: signed message length does not match unsigned message — wallet may have tampered with the transaction"
    );
  }
  for (let i = 0; i < originalMessageBytes.length; i++) {
    if (signedMessageBytes[i] !== originalMessageBytes[i]) {
      throw new Error(
        `wallet-bridge: signed message byte ${i} does not match unsigned message — wallet may have tampered with the transaction`
      );
    }
  }

  // 5. Convert the signed web3.js VersionedTransaction back to a Kit
  //    Transaction (with signatures populated).
  const signedKitTx = fromVersionedTransaction(signedVersionedTx);

  // 6. Narrow the lifetime union to "blockhash" so sendAndConfirm accepts
  //    it. Kit 6 widened the lifetime type to blockhash | durable-nonce;
  //    we set the blockhash via setTransactionMessageLifetimeUsingBlockhash
  //    upstream so this is a runtime no-op type narrow.
  assertIsTransactionWithBlockhashLifetime(signedKitTx);

  // 7. Apply the FullySignedTransaction + TransactionWithinSizeLimit brands
  //    that sendAndConfirm requires. `fromVersionedTransaction` doesn't
  //    apply them automatically — this throws if the wallet returned an
  //    incomplete signature set or the tx exceeds the size limit, both of
  //    which are real conditions worth surfacing as errors.
  assertIsSendableTransaction(signedKitTx);

  // 8. Send and confirm via Kit. The 45-second timeout is intentionally
  //    a few seconds shorter than Solana's blockhash expiry (~60s) so a
  //    hung RPC fails fast with a clear error before the user sees an
  //    indefinite "loading" state and double-clicks. The hook's re-entry
  //    guard catches double-clicks regardless, but the timeout improves
  //    UX significantly on slow public RPCs (devnet rate limiting).
  await getSendAndConfirm()(signedKitTx, {
    abortSignal: AbortSignal.timeout(45_000),
    commitment: "confirmed",
  });

  return getSignatureFromTransaction(signedKitTx);
}
