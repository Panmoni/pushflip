# Solana Kit: Complete Reference Guide

> **Decision**: Use `@solana/kit` + Kit Plugins directly. **Not Gill.** Per beeman's recommendation — Kit with Kit Plugins is the way to go. Gill is an unnecessary wrapper layer.

## What Is Kit?

Kit (`@solana/kit`) is the **official JavaScript SDK for Solana**, maintained by Anza (the Agave validator team). It started life as the renamed 2.x line of `@solana/web3.js` — a complete ground-up rewrite, not a version bump — and is currently shipping as v6.

- **Package**: `@solana/kit` on npm (v6.8.0 — pinned at `^6.8.0` workspace-wide)
- **Repo**: https://github.com/anza-xyz/kit
- **Docs**: https://www.solanakit.com/docs
- **License**: MIT
- **Requires**: Node >= 20.18.0, TypeScript >= 5.0.0

## Why Kit Over Gill?

| | Kit + Kit Plugins | Gill |
|---|---|---|
| **Maintained by** | Anza (official) | Nick Frostbutter (DevRel) |
| **Architecture** | Composable plugins, full control | Opinionated wrapper over Kit |
| **What it adds** | Nothing — it IS the SDK | React hooks, convenience abstractions |
| **For our use case** | Perfect — we need low-level control for Pinocchio + ZK | Adds abstraction we don't need |
| **Community direction** | beeman recommends Kit + Kit Plugins | Being superseded by Kit Plugins |

Gill re-exports all Kit primitives + adds "lightly opinionated abstractions." For PushFlip (Pinocchio native programs, ZK proofs, custom account layouts), we want full control — Kit directly.

## Design Philosophy

- **Tree-shakeable**: Functions, not classes. A lamport transfer: 111KB (old) → 18.2KB (Kit) — **83% reduction**
- **Zero dependencies**: All `@solana/*` packages. Uses native Web Crypto Ed25519, native `bigint`
- **Functional**: No classes (except `SolanaError`). Immutable transaction messages composed via `pipe()`
- **Type-safe**: TypeScript catches missing fee payers, unsigned transactions, wrong value types at compile time
- **Composable**: Custom RPC transports, retry logic, failover — all developer-composable

### Performance vs Legacy web3.js 1.x

| Metric | 1.x | Kit | Change |
|--------|-----|-----|--------|
| Total minified size | 81 KB | 53 KB | -33% |
| Lamport transfer bundle | 111 KB | 18.2 KB | -83% |
| Key gen/sign/verify | 700 ops/s | 7000 ops/s | +900% |
| Confirmation latency | baseline | ~200ms faster | - |

## Core Packages

The `@solana/kit` umbrella re-exports these:

| Package | Purpose |
|---------|---------|
| `@solana/accounts` | Fetching and decoding accounts |
| `@solana/addresses` | Base58 address utilities |
| `@solana/codecs` | Composable (de)serialization primitives |
| `@solana/errors` | Coded errors |
| `@solana/functional` | `pipe()` and functional utilities |
| `@solana/instructions` | Instruction types |
| `@solana/instruction-plans` | Multi-step operation composition |
| `@solana/keys` | CryptoKey / Ed25519 operations |
| `@solana/plugin-core` | Plugin system (`createEmptyClient`, `extendClient`) |
| `@solana/plugin-interfaces` | Plugin type interfaces |
| `@solana/programs` | Program utilities |
| `@solana/rpc` | HTTP RPC communication |
| `@solana/rpc-subscriptions` | WebSocket subscriptions |
| `@solana/signers` | Message/transaction signer objects |
| `@solana/sysvars` | Sysvar account fetching/decoding |
| `@solana/transaction-messages` | Building/transforming tx messages |
| `@solana/transactions` | Compiling and signing transactions |
| `@solana/transaction-confirmation` | Confirmation strategies |

### Program Client Packages (Codama-generated)

| Package | Purpose |
|---------|---------|
| `@solana-program/system` | System program instructions |
| `@solana-program/memo` | Memo program |
| `@solana-program/compute-budget` | Compute budget instructions |
| `@solana-program/token` | SPL Token instructions |

### Utility Packages

| Package | Purpose |
|---------|---------|
| `@solana/compat` | Interop between legacy web3.js 1.x types and Kit types |
| `@solana/webcrypto-ed25519-polyfill` | Polyfill for runtimes without Ed25519 support |
| `@solana/rpc-graphql` | Experimental GraphQL API for Solana RPC |

## Kit Plugins

**Repo**: https://github.com/anza-xyz/kit-plugins

Plugins extend a client object via `.use()` chaining. They are composable, type-safe, and can have requirements enforced by TypeScript.

```ts
type ClientPlugin<TInput extends object, TOutput extends Promise<object> | object> = (input: TInput) => TOutput;
```

### Available Client Presets

| Package | Description | Exports |
|---------|-------------|---------|
| `@solana/kit-client-rpc` | Pre-configured RPC client | `createClient`, `createLocalClient` |
| `@solana/kit-client-litesvm` | Pre-configured LiteSVM client | `createClient` |

### Available Plugins

| Package | Plugins |
|---------|---------|
| `@solana/kit-plugin-rpc` | `rpc`, `localhostRpc`, `rpcAirdrop`, `rpcGetMinimumBalance`, `rpcTransactionPlanner`, `rpcTransactionPlanExecutor` |
| `@solana/kit-plugin-payer` | `payer`, `payerFromFile`, `generatedPayer`, `generatedPayerWithSol` |
| `@solana/kit-plugin-litesvm` | `litesvm`, `litesvmAirdrop`, `litesvmGetMinimumBalance`, `litesvmTransactionPlanner`, `litesvmTransactionPlanExecutor` |
| `@solana/kit-plugin-instruction-plan` | `transactionPlanner`, `transactionPlanExecutor`, `planAndSendTransactions` |

### Quick Start Examples

**Production client:**
```ts
import { generateKeyPairSigner } from '@solana/kit';
import { createClient } from '@solana/kit-client-rpc';

const payer = await generateKeyPairSigner();
const client = createClient({ payer, url: 'https://api.devnet.solana.com' });
await client.sendTransaction([myInstruction]);
```

**Local development:**
```ts
import { createLocalClient } from '@solana/kit-client-rpc';

const client = await createLocalClient();
// Payer is auto-generated and funded
await client.sendTransaction([myInstruction]);
```

**LiteSVM testing:**
```ts
import { createClient } from '@solana/kit-client-litesvm';

const client = await createClient();
client.svm.setAccount(myTestAccount);
client.svm.addProgramFromFile(myProgramAddress, 'program.so');
await client.sendTransaction([myInstruction]);
```

**Custom client composition (full control):**
```ts
import { createEmptyClient } from '@solana/kit';
import { rpc, rpcAirdrop, rpcTransactionPlanner, rpcTransactionPlanExecutor } from '@solana/kit-plugin-rpc';
import { payerFromFile } from '@solana/kit-plugin-payer';
import { planAndSendTransactions } from '@solana/kit-plugin-instruction-plan';

const client = await createEmptyClient()
    .use(rpc('https://api.devnet.solana.com'))
    .use(payerFromFile('path/to/keypair.json'))
    .use(rpcAirdrop())
    .use(rpcTransactionPlanner())
    .use(rpcTransactionPlanExecutor())
    .use(planAndSendTransactions());
```

### Writing Custom Plugins

```ts
import { extendClient } from '@solana/kit';

// Simple plugin
function apple() {
    return <T extends object>(client: T) => extendClient(client, { fruit: 'apple' as const });
}

// Plugin with requirements (TypeScript-enforced)
function appleTart() {
    return <T extends { fruit: 'apple' }>(client: T) => extendClient(client, { dessert: 'appleTart' as const });
}

createEmptyClient().use(apple()).use(appleTart()); // OK
createEmptyClient().use(appleTart()); // TypeScript error!

// Async plugins supported
function magicFruit() {
    return async <T extends object>(client: T) => {
        const fruit = await fetchSomeMagicFruit();
        return extendClient(client, { fruit });
    };
}
```

## Key APIs

### RPC Connections

```ts
import { createSolanaRpc, createSolanaRpcSubscriptions, mainnet, devnet } from '@solana/kit';

const rpc = createSolanaRpc('http://127.0.0.1:8899');
const rpcSubscriptions = createSolanaRpcSubscriptions('ws://127.0.0.1:8900');

// Cluster-typed (devnetRpc.requestAirdrop works; mainnetRpc.requestAirdrop is a type error)
const mainnetRpc = createSolanaRpc(mainnet('https://api.mainnet-beta.solana.com'));
const devnetRpc = createSolanaRpc(devnet('https://api.devnet.solana.com'));
```

### Keypairs and Addresses

```ts
import { generateKeyPair, generateKeyPairSigner, address, getAddressFromPublicKey } from '@solana/kit';

// All key ops are ASYNC (Web Crypto)
const keyPair = await generateKeyPair();
const signer = await generateKeyPairSigner();

// Addresses are branded strings, not PublicKey objects
const myAddress = address('AxZfZWeqztBCL37Mkjkd4b8Hf6J13WCcfozrBY6vZzv3');
const addrFromKey = await getAddressFromPublicKey(keyPair.publicKey);
```

### Building Transactions (pipe pattern)

```ts
import {
    pipe, createTransactionMessage, setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstruction,
    lamports, address
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';

const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

const instruction = getTransferSolInstruction({
    amount: lamports(1_000_000_000n),
    destination: address('...'),
    source: signer,
});

const txMsg = pipe(
    createTransactionMessage({ version: 0 }),
    tx => setTransactionMessageFeePayer(signer.address, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    tx => appendTransactionMessageInstruction(instruction, tx),
);
```

### Signing and Sending

```ts
import { signTransactionMessageWithSigners, sendAndConfirmTransactionFactory, getSignatureFromTransaction } from '@solana/kit';

const signedTx = await signTransactionMessageWithSigners(txMsg);

const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
await sendAndConfirm(signedTx, { commitment: 'confirmed' });

console.log('Signature:', getSignatureFromTransaction(signedTx));
```

### Compute Unit Estimation

```ts
import { estimateComputeUnitLimitFactory } from '@solana/kit';
import { getSetComputeUnitPriceInstruction, getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';

const estimateComputeUnitLimit = estimateComputeUnitLimitFactory({ rpc });
let computeUnits = await estimateComputeUnitLimit(txMsg);
computeUnits = Math.ceil(computeUnits * 1.1); // 10% buffer
```

### RPC Subscriptions (AsyncIterators)

```ts
const abortController = new AbortController();
const notifications = await rpcSubscriptions
    .accountNotifications(address('...'), { commitment: 'confirmed' })
    .subscribe({ abortSignal: abortController.signal });

try {
    for await (const notif of notifications) {
        console.log('Balance:', notif.value.lamports);
    }
    // Reaching here = subscription was aborted (unsubscribed)
} catch (e) {
    // Subscription went down — retry + catch up
}
```

### Codecs (Serialization)

```ts
import { getStructCodec } from '@solana/codecs-data-structures';
import { getU64Codec, getU8Codec } from '@solana/codecs-numbers';

const codec = getStructCodec([
    ['amount', getU64Codec()],
    ['decimals', getU8Codec()],
]);
const encoded = codec.encode({ amount: 1000n, decimals: 2 });
const decoded = codec.decode(encoded);
```

### Legacy Interop (if needed)

```ts
import { fromLegacyPublicKey, fromLegacyKeypair, fromVersionedTransaction } from '@solana/compat';

const addr = fromLegacyPublicKey(legacyPublicKey);
const kp = fromLegacyKeypair(legacyKeypair);
const tx = fromVersionedTransaction(legacyVersionedTransaction);
```

## Key Differences from Legacy web3.js 1.x

| Aspect | web3.js 1.x | Kit |
|--------|-------------|-----|
| Architecture | Class-based (`Connection`, `PublicKey`) | Functional, no classes |
| Tree-shaking | Impossible | Fully tree-shakeable |
| Bundle size | 81 KB min | 53 KB min |
| Keys | `PublicKey` class, `Keypair` class | String `Address`, `CryptoKeyPair` |
| Crypto | tweetnacl (userspace) | Native Web Crypto Ed25519 |
| Numbers | `BN.js` | Native `bigint` |
| Transactions | `Transaction` vs `VersionedTransaction` | Single version-aware type |
| RPC | `Connection` class (all 80+ methods) | `createSolanaRpc()` function |
| Subscriptions | Silent retries, no gap recovery | Explicit errors, `AsyncIterator` |
| Customization | Very limited | Fully composable transports |
| Types | Basic | Advanced compile-time safety |
| Key ops | Synchronous | Asynchronous (Web Crypto) |
| Amounts | Raw numbers | `lamports()` wrapper enforced by types |

## Gotchas

1. **All key operations are async** — `generateKeyPair()`, `signBytes()`, `getAddressFromPublicKey()` return Promises (Web Crypto API)

2. **Addresses are branded strings** — No `PublicKey`. Use `address('...')` to coerce. The `Address` type is opaque.

3. **`lamports()` is required** — TypeScript forces `lamports(1_000_000_000n)`, no raw numbers for amounts

4. **`bigint` everywhere** — Slots, lamports, compute units use `bigint`. Add `n` suffix: `1000n`

5. **Transaction messages are immutable** — Each transform returns a new frozen object. Use `pipe()`

6. **AbortController required for subscriptions** — Must pass `AbortSignal` to `.subscribe()`. Prevents leaks by design.

7. **Subscription failure vs abort** — Failed subscription throws in `for await`. Aborted exits cleanly. Handle both.

8. **No `Connection` class** — Replace with `createSolanaRpc()` + `createSolanaRpcSubscriptions()`

9. **`signTransaction` requires fee payer AND lifetime** — TypeScript errors if either missing. Catches bugs at compile time.

10. **Ed25519 polyfill may be needed** — Some runtimes lack Web Crypto Ed25519. Install `@solana/webcrypto-ed25519-polyfill` if needed.

11. **CU estimation needs buffer** — Add ~10% to `estimateComputeUnitLimit` results

12. **Program clients are Codama-generated** — `@solana-program/system` etc. are auto-generated from IDLs, not hand-written

## PushFlip-Specific Usage

### Frontend (app/)
```
@solana/kit                          — core SDK
@solana/kit-client-rpc               — createClient() preset
@solana/kit-plugin-rpc               — RPC plugins
@solana/kit-plugin-payer             — fee payer management
@solana/kit-plugin-instruction-plan  — tx planning & execution
```

### House AI Agent (house-ai/)
```
@solana/kit                          — core SDK
@solana/kit-client-rpc               — createClient() preset
@solana/kit-plugin-rpc               — RPC subscriptions for monitoring
@solana/kit-plugin-payer             — payerFromFile() for house wallet
```

### Integration Tests
```
@solana/kit-client-litesvm           — LiteSVM client preset
@solana/kit-plugin-litesvm           — LiteSVM plugins
```

## Sources

- [Kit GitHub](https://github.com/anza-xyz/kit)
- [Kit Plugins GitHub](https://github.com/anza-xyz/kit-plugins)
- [Kit Docs](https://www.solanakit.com/docs)
- [Meet Kit — Anza Blog](https://www.anza.xyz/blog/meet-kit-the-new-solana-javascript-sdk)
- [Intro to Kit — Triton One](https://blog.triton.one/intro-to-the-new-solana-kit-formerly-web3-js-2/)
- [npm: @solana/kit](https://www.npmjs.com/package/@solana/kit)
