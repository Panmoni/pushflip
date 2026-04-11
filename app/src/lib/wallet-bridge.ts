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
  getBase64Decoder,
  getSignatureFromTransaction,
  type Signature,
  sendAndConfirmTransactionFactory,
  type TransactionMessage,
  type TransactionMessageWithBlockhashLifetime,
  type TransactionMessageWithFeePayer,
} from "@solana/kit";
import { VersionedMessage, VersionedTransaction } from "@solana/web3.js";

import { debugBridge } from "./debug-log";
import { rpc, rpcSubscriptions } from "./program";
import {
  CLUSTER_MISMATCH_MESSAGE,
  extractProgramLogs,
  isWalletClusterMismatch,
  TransactionSimulationError,
} from "./tx-error";

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
 * Run an app-side simulation of the transaction against our Kit RPC
 * BEFORE asking the wallet to sign. Two reasons this is worth doing:
 *
 *  1. **Catch app-built bugs without burning wallet trust.** If we
 *     constructed an instruction with bad accounts or a malformed
 *     instruction byte layout, the wallet's "confirm transaction"
 *     modal is a terrible place to discover it: the user sees a
 *     generic failure, has to dismiss the popup, and loses faith in
 *     the app. Catching it here means we never show the popup in the
 *     first place — we just toast the real error with program logs.
 *  2. **Distinguish app-side bugs from wallet-cluster mismatches.**
 *     If our simulation passes but the wallet's own internal
 *     simulation later fails, we know with high confidence that the
 *     wallet is pointed at a different cluster than our RPC. Phantom
 *     has no API to switch clusters, so the next best thing is to
 *     detect the condition and show a specific hint. `runAction`
 *     uses the `app-simulation → wallet-simulation` transition to
 *     decide which error to render.
 *
 * Simulation runs with `sigVerify: false` + `replaceRecentBlockhash:
 * true`:
 *   - `sigVerify: false` — we don't have a signature yet (that's the
 *     whole point of running this pre-wallet).
 *   - `replaceRecentBlockhash: true` — the blockhash on the compiled
 *     message may be a few seconds old by the time the RPC processes
 *     the call. Letting the RPC swap in its own recent blockhash
 *     sidesteps a spurious "blockhash not found" failure.
 *
 * **Tradeoff**: swapping the blockhash means this simulation checks
 * program-level validity but NOT blockhash freshness. If the compiled
 * message's blockhash is already expired (>60s stale, e.g. because
 * the user sat in the wallet popup for a minute), pre-sim will still
 * pass. The subsequent `sendAndConfirm` call will then fail with
 * "blockhash not found", and its 45-second abort-signal timeout is
 * the compensating control. Prefer catching program-level bugs here
 * over catching blockhash aging, because program-level bugs are much
 * more common and much harder to debug from a wallet-popup rejection.
 *
 * Throws `TransactionSimulationError` with `kind: "app-simulation"`
 * if the RPC returns a non-null `err`. Does NOT throw on network
 * failures (RPC down, timeout, malformed response) — those are
 * logged and swallowed so a flaky RPC doesn't prevent a legitimate
 * submission. The wallet-side simulation will catch the same class
 * of program-level bug as a fallback.
 */
async function preSimulateTransaction(
  wireTransaction: Uint8Array
): Promise<void> {
  // `Base64EncodedWireTransaction` is a branded `string` subtype that
  // Kit's `simulateTransaction` requires at the argument position. The
  // decoder returns a plain string; the cast at the call site is the
  // one place we bridge the brand gap.
  const wireBase64 = getBase64Decoder().decode(wireTransaction);
  debugBridge("pre-sim: start", {
    wireLength: wireTransaction.length,
    wireBase64Preview: `${wireBase64.slice(0, 48)}…`,
  });
  try {
    const result = await rpc
      .simulateTransaction(
        wireBase64 as Parameters<typeof rpc.simulateTransaction>[0],
        {
          encoding: "base64",
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: "confirmed",
        }
      )
      .send();

    debugBridge("pre-sim: result", {
      err: result.value.err,
      unitsConsumed: result.value.unitsConsumed?.toString(),
      logCount: result.value.logs?.length ?? 0,
      logs: result.value.logs,
    });

    if (result.value.err !== null) {
      const logs = result.value.logs ?? [];
      const errDescriptor = JSON.stringify(result.value.err);
      throw new TransactionSimulationError({
        kind: "app-simulation",
        message: `Pre-flight simulation failed: ${errDescriptor}`,
        logs,
        rawError: result.value.err,
      });
    }
    debugBridge("pre-sim: passed");
  } catch (e) {
    // Re-throw our own errors; log+swallow transport errors (RPC down,
    // network timeout, malformed response) so the wallet flow can still
    // attempt the transaction. Routed through `debugBridge` so the
    // message is gated on `import.meta.env.DEV` and is silent in
    // production builds — a flaky public RPC shouldn't spam every
    // end-user's browser console.
    if (e instanceof TransactionSimulationError) {
      debugBridge("pre-sim: failed with app-simulation error", {
        message: e.message,
        logs: e.logs,
      });
      throw e;
    }
    debugBridge("pre-sim: transport error, continuing to wallet sign", {
      error: e,
    });
  }
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
  debugBridge("sign+send: start", {
    feePayer: message.feePayer.address,
    blockhash: message.lifetimeConstraint.blockhash,
    lastValidBlockHeight:
      message.lifetimeConstraint.lastValidBlockHeight.toString(),
    instructionCount: message.instructions.length,
  });

  // 1. Compile the Kit message to wire-format bytes.
  const compiled = compileTransaction(message);
  const originalMessageBytes = new Uint8Array(compiled.messageBytes);
  debugBridge("step 1: compiled Kit message", {
    messageBytesLength: originalMessageBytes.length,
    hasLifetimeConstraint: "lifetimeConstraint" in compiled,
  });

  // 2. Wrap the message bytes as a web3.js VersionedTransaction so the
  //    wallet adapter can recognize and sign it. `compiled.messageBytes`
  //    is a branded ReadonlyUint8Array; the copy above gives us a
  //    mutable Uint8Array for web3.js's deserializer AND a stable
  //    reference for the post-sign verification step below.
  const versionedTx = new VersionedTransaction(
    VersionedMessage.deserialize(originalMessageBytes)
  );
  debugBridge("step 2: wrapped as web3.js VersionedTransaction", {
    staticAccountKeyCount: versionedTx.message.staticAccountKeys.length,
    numRequiredSignatures: versionedTx.message.header.numRequiredSignatures,
  });

  // 2.5. Pre-simulate the unsigned transaction against our devnet RPC.
  //      Catches app-built tx bugs BEFORE the wallet shows its modal,
  //      and establishes the "our sim passed" precondition that
  //      `isWalletClusterMismatch` relies on below.
  const wireTx = versionedTx.serialize();
  await preSimulateTransaction(wireTx);

  // 3. Hand off to the wallet for the user to approve. A rejection here
  //    with a simulation-related message (after our own simulation
  //    passed) almost certainly means the wallet is on a different
  //    cluster than our RPC — Phantom's scary "Funds may be lost if
  //    submitted" warning. Remap to a specific hint so the toast tells
  //    the user exactly how to recover.
  debugBridge("step 3: requesting wallet signature");
  let signedVersionedTx: VersionedTransaction;
  try {
    signedVersionedTx = await walletSignTransaction(versionedTx);
    debugBridge("step 3: wallet returned signed tx", {
      signatureCount: signedVersionedTx.signatures.length,
      firstSignatureIsZero: signedVersionedTx.signatures[0]?.every(
        (b) => b === 0
      ),
    });
  } catch (err) {
    debugBridge("step 3: wallet rejected signing", { error: err });
    if (isWalletClusterMismatch(err)) {
      throw new TransactionSimulationError({
        kind: "wallet-simulation",
        message: "Wallet rejected the transaction at simulation",
        humanHint: CLUSTER_MISMATCH_MESSAGE,
        rawError: err,
      });
    }
    throw err;
  }

  // 4. Defense-in-depth: verify the wallet returned a transaction whose
  //    message bytes match what we asked it to sign. A buggy wallet
  //    adapter — or a malicious browser extension intercepting the wallet
  //    RPC — could swap the message body and have the user sign an
  //    attacker's transaction. Comparing the serialized message before
  //    accepting the signature catches both cases. Cheap (one serialize +
  //    one byte loop) and runs once per action.
  const signedMessageBytes = signedVersionedTx.message.serialize();
  if (signedMessageBytes.length !== originalMessageBytes.length) {
    debugBridge("step 4: tamper check failed (length mismatch)", {
      signedLength: signedMessageBytes.length,
      originalLength: originalMessageBytes.length,
    });
    throw new Error(
      "wallet-bridge: signed message length does not match unsigned message — wallet may have tampered with the transaction"
    );
  }
  for (let i = 0; i < originalMessageBytes.length; i++) {
    if (signedMessageBytes[i] !== originalMessageBytes[i]) {
      debugBridge("step 4: tamper check failed (byte mismatch)", {
        offset: i,
        signedByte: signedMessageBytes[i],
        originalByte: originalMessageBytes[i],
      });
      throw new Error(
        `wallet-bridge: signed message byte ${i} does not match unsigned message — wallet may have tampered with the transaction`
      );
    }
  }
  debugBridge("step 4: tamper check passed");

  // 5. Convert the signed web3.js VersionedTransaction back to a Kit
  //    Transaction (with signatures populated) AND re-attach the
  //    blockhash lifetime constraint.
  //
  //    **Why the re-attach is necessary**: `@solana/compat`'s
  //    `fromVersionedTransaction` builds its result from ONLY
  //    `{ messageBytes, signatures }` (see compat@6.8.0
  //    index.node.mjs:65). It does NOT copy over
  //    `lifetimeConstraint`, because the VersionedTransaction wire
  //    format doesn't distinguish blockhash lifetimes from durable-
  //    nonce lifetimes — both use the same message bytes. The Kit
  //    `Transaction` type tracks that distinction as a TypeScript
  //    brand AND as a runtime `lifetimeConstraint: { blockhash, ... }`
  //    field, and `assertIsTransactionWithBlockhashLifetime` checks
  //    the runtime field. Without this merge, the assertion fails
  //    with "Transaction does not have a blockhash lifetime" — which
  //    is exactly what broke our first real Solflare end-to-end
  //    test (Phantom had been failing earlier at cluster-mismatch).
  //
  //    We already have the blockhash lifetime from the original Kit
  //    message (`message.lifetimeConstraint`), so merging it back
  //    in is lossless — no extra RPC call needed.
  const bareSigned = fromVersionedTransaction(signedVersionedTx);
  // Dev-only canary: if a future version of `@solana/compat` starts
  // populating `lifetimeConstraint` itself, our unconditional merge
  // would silently overwrite the library's value. The verification
  // cost is one property lookup — cheap to run always, but we gate
  // it on DEV so the warning fires where a developer will see it
  // and never ships to production consoles.
  if (import.meta.env.DEV && "lifetimeConstraint" in bareSigned) {
    debugBridge(
      "step 5: WARNING — @solana/compat now populates lifetimeConstraint; re-evaluate the merge",
      {
        bareLifetime: (bareSigned as { lifetimeConstraint?: unknown })
          .lifetimeConstraint,
      }
    );
  }
  const signedKitTx = {
    ...bareSigned,
    lifetimeConstraint: message.lifetimeConstraint,
  };
  debugBridge("step 5: reconstructed Kit Transaction", {
    signatureEntries: Object.keys(signedKitTx.signatures).length,
    lifetimeBlockhash: signedKitTx.lifetimeConstraint.blockhash,
  });

  // 6. Narrow the lifetime union to "blockhash" so sendAndConfirm accepts
  //    it. Kit 6 widened the lifetime type to blockhash | durable-nonce;
  //    we set the blockhash via setTransactionMessageLifetimeUsingBlockhash
  //    upstream so this assertion is a no-op type narrow AFTER step 5
  //    re-attaches the runtime field.
  assertIsTransactionWithBlockhashLifetime(signedKitTx);
  debugBridge("step 6: lifetime assertion passed");

  // 7. Apply the FullySignedTransaction + TransactionWithinSizeLimit brands
  //    that sendAndConfirm requires. `fromVersionedTransaction` doesn't
  //    apply them automatically — this throws if the wallet returned an
  //    incomplete signature set or the tx exceeds the size limit, both of
  //    which are real conditions worth surfacing as errors.
  assertIsSendableTransaction(signedKitTx);
  debugBridge("step 7: sendable assertion passed");

  // 8. Send and confirm via Kit. The 45-second timeout is intentionally
  //    a few seconds shorter than Solana's blockhash expiry (~60s) so a
  //    hung RPC fails fast with a clear error before the user sees an
  //    indefinite "loading" state and double-clicks. The hook's re-entry
  //    guard catches double-clicks regardless, but the timeout improves
  //    UX significantly on slow public RPCs (devnet rate limiting).
  //
  //    Wrap to extract program logs from the thrown SolanaError if the
  //    send fails after the wallet signed. Without this the UI would
  //    show only a terse "Transaction failed" message; the program logs
  //    are always the first thing a developer debugging a failure
  //    wants to see.
  debugBridge("step 8: send+confirm start");
  try {
    await getSendAndConfirm()(signedKitTx, {
      abortSignal: AbortSignal.timeout(45_000),
      commitment: "confirmed",
    });
    debugBridge("step 8: send+confirm ok");
  } catch (err) {
    const logs = extractProgramLogs(err);
    debugBridge("step 8: send+confirm failed", {
      error: err,
      logs,
    });
    throw new TransactionSimulationError({
      kind: "send",
      message:
        err instanceof Error ? err.message : "Transaction failed after signing",
      logs,
      rawError: err,
    });
  }

  const signature = getSignatureFromTransaction(signedKitTx);
  debugBridge("sign+send: complete", { signature });
  return signature;
}
