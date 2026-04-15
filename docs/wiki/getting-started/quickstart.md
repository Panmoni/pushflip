---
title: Quickstart
diataxis_type: tutorial
last_compiled: 2026-04-15
---

# Quickstart

Zero to a working devnet loop in about 20 minutes, assuming you're starting from a fresh machine. The goal of this page is **one successful smoke test run + one joinable game at `game_id=1` + a running dev server**. Everything else is optional.

If you're here to contribute, also read [Contributing](contributing.md) for code conventions and open work tracks.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| **Rust** | 1.84+ | Matches the BPF toolchain. `rustup install stable` is usually enough. |
| **Solana CLI** | 2.x | `sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"` |
| **Node.js** | 20.11+ | Use [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm) if your distro ships something older. |
| **pnpm** | 9+ | `corepack enable && corepack prepare pnpm@latest --activate` |
| **Python** | 3.12+ | Only needed if you're editing the wiki locally. |
| **circom** | 2.x | Only needed if you're rebuilding the ZK circuit. `npm i -g circom` or follow [iden3's install guide](https://docs.circom.io/). |

Check your install:

```bash
rustc --version       # rustc 1.84.x or newer
solana --version      # solana-cli 2.x
node --version        # v20.11+ or newer
pnpm --version        # 9.x or newer
```

## Clone and install

```bash
git clone https://github.com/Panmoni/pushflip.git
cd pushflip
pnpm install
```

`pnpm install` wires up the workspaces ([clients/js/](https://github.com/Panmoni/pushflip/tree/main/clients/js), [dealer/](https://github.com/Panmoni/pushflip/tree/main/dealer), [app/](https://github.com/Panmoni/pushflip/tree/main/app), [scripts/](https://github.com/Panmoni/pushflip/tree/main/scripts)) in one pass.

## Set up a devnet wallet

If you don't already have a Solana CLI keypair:

```bash
solana-keygen new --outfile ~/.config/solana/id.json
solana config set --url devnet
solana airdrop 2
solana balance
```

Expected: `2 SOL` (after the airdrop lands — can take a few seconds on devnet). Every CLI script in this repo loads this keypair via [`loadCliKeypair`](https://github.com/Panmoni/pushflip/blob/main/scripts/lib/script-helpers.ts) from the shared helpers module — friendly errors if the file is missing, unreadable, or malformed.

## Build the on-chain program

```bash
cargo build-sbf --manifest-path program/Cargo.toml --sbf-out-dir target/deploy
```

This produces `target/deploy/pushflip.so` (~107 KB). Don't build with `--features skip-zk-verify` — the build script prints a loud `cargo:warning=` block if you do; that feature is for LiteSVM-based unit tests only and is fatal for devnet use.

## Run the smoke test

The devnet smoke test is the golden regression guard. It runs the full lifecycle end-to-end:

```bash
pnpm --filter @pushflip/scripts smoke-test
```

Expected output (abbreviated):

```
[0] Load wallet and generate ephemeral keypairs    ✓
[1] Fund ephemeral accounts from local wallet      ✓
[2] Initialize game session                        ✓
[3] Both players join                              ✓
[4] Dealer shuffles, generates Groth16 proof,      ✓  (~20s for proof gen)
    commits deck
[5] Authority starts the round                     ✓
[6] Player A calls hit()                           ✓  (commit_deck CU: 86175/200000)
                                                      (hit CU: 9508/12000)
[7] Verify revealed card is in player A's hand     ✓
[8] Player B's turn — hit once then stay           ✓
[9] Authority calls end_round()                    ✓
[10-12] leave_game ×2 + close_game                 ✓

✓ SMOKE TEST PASSED
```

The whole run takes about 50 seconds and costs a few thousand lamports (all rent refunded at `close_game`). If anything fails, see [Troubleshooting](#troubleshooting) below.

Other smoke tests that exercise different paths (token economy, bounty boards, burn mechanics):

```bash
pnpm --filter @pushflip/scripts smoke-test-tokens
pnpm --filter @pushflip/scripts smoke-test-bounty
pnpm --filter @pushflip/scripts smoke-test-burns
```

## Initialize a persistent test game

The frontend hardcodes `GAME_ID=1` and reads from whatever is at that PDA. Create a persistent GameSession there:

```bash
pnpm --filter @pushflip/scripts init-game
```

This is **idempotent**: if a game already exists at `game_id=1`, the script prints its current state and exits 0 without re-sending. Safe to re-run.

Result: a GameSession at PDA [`Hk6RLHBZ8oppV4KtQFFRsHC21z9tCL5HYz3cLELEA64A`](https://explorer.solana.com/address/Hk6RLHBZ8oppV4KtQFFRsHC21z9tCL5HYz3cLELEA64A?cluster=devnet) that `vault_ready=false` (so `joinRound` validates stake but skips the SPL transfer). Perfect for the first wallet-bridge round-trip.

If you want real-stake mode (i.e., `joinRound` actually transfers $FLIP tokens), run:

```bash
pnpm --filter @pushflip/scripts init-vault   # IRREVERSIBLE — only the game authority can do this
```

See [`init-vault.ts`](https://github.com/Panmoni/pushflip/blob/main/scripts/init-vault.ts) for the "only the authority can initialize the vault" rationale (heavy-duty review #5 H1).

## Start the dev server

```bash
pnpm --filter @pushflip/app dev
```

Open `http://localhost:5173`, connect a wallet (Phantom, Solflare, or any Wallet Standard adapter — the Wallet Standard auto-discovery handles the rest). Make sure the wallet is on **devnet** — the `<ClusterHint>` banner will warn you if it's not.

From there you can:

- Read the board state (game at `game_id=1`)
- Join the round with a stake (any amount ≥ `MIN_STAKE = 100 $FLIP` for real-stake; any amount for test-stake where `vault_ready=false`)
- Watch the ZK deck commit + Groth16 proof verification land on-chain
- Hit, stay, burn scry, burn second chance, leave

## Get some test $FLIP (if needed)

If your wallet has no `$FLIP` ATA, the Join dialog blocks. Mint some to yourself:

```bash
pnpm --filter @pushflip/scripts mint-test-flip --to <YOUR_WALLET_ADDRESS>
# default: 1000 $FLIP (whole units)
pnpm --filter @pushflip/scripts mint-test-flip --to <YOUR_WALLET_ADDRESS> --amount 5000
```

The test mint is [`2KqqB7SRVaD98ZbVaiRWirxbaJv5ryNzkDRGweBZVryF`](https://explorer.solana.com/address/2KqqB7SRVaD98ZbVaiRWirxbaJv5ryNzkDRGweBZVryF?cluster=devnet), authority = your CLI wallet. Only the mint authority (whoever cloned this repo and ran `solana-keygen new`) can mint; there's no self-service faucet yet (see [Pre-Mainnet Checklist](https://github.com/Panmoni/pushflip/blob/main/docs/EXECUTION_PLAN.md) item 5.0.7).

## Preview the wiki locally

Optional, only if you're editing these pages:

```bash
# One-time setup
python3 -m venv wiki/.venv
wiki/.venv/bin/pip install -r wiki/requirements.txt

# Serve locally
wiki/.venv/bin/mkdocs serve -f wiki/mkdocs.yml
```

Open `http://127.0.0.1:8000` and your edits live-reload. The health check that gates PRs runs via:

```bash
bash scripts/wiki-health-check.sh --strict
wiki/.venv/bin/mkdocs build -f wiki/mkdocs.yml --strict
```

Both must pass clean before a wiki change can land.

## Next steps

- Build a component or fix a bug: read [Contributing](contributing.md), then pick something from the open work tracks in `CONTRIBUTING.md`.
- Understand how the pieces fit: [System Design](../architecture/index.md) → [Glossary](../architecture/glossary.md) → [FAQ](../reference/faq.md).
- Understand the security story: [Threat Model](../architecture/threat-model.md).
- Understand the ZK pipeline: [ZK Research](../reference/zk-research.md).

## Troubleshooting

**Smoke test hangs on "generating Groth16 proof".** The proof takes ~20 seconds on a single core. If it's been more than a minute, the dealer process probably wedged. Kill the script (Ctrl-C) and re-run. The `retry` helper in [`scripts/lib/script-helpers.ts`](https://github.com/Panmoni/pushflip/blob/main/scripts/lib/script-helpers.ts) handles transient RPC drops but not proof-gen hangs.

**`Transaction simulation failed: Attempt to debit an account but found no record of a prior credit`**. Your CLI wallet is out of SOL. Run `solana airdrop 2` (devnet airdrops are rate-limited to 2 SOL per 24h per IP — use [faucet.solana.com](https://faucet.solana.com) if that's throttled).

**`Error: CLI wallet not found at /home/you/.config/solana/id.json. Create one with: solana-keygen new`**. The friendly-error `loadCliKeypair` working as intended — follow its suggestion.

**`Error: CLI wallet at ~/.config/solana/id.json is not valid JSON`**. The file is corrupted. Re-create with `solana-keygen new`.

**The Join dialog says "No $FLIP account — mint some first" even though I have SOL**. Your wallet is missing a `$FLIP` Associated Token Account. Run the `mint-test-flip` command above with your wallet address as `--to`.

**The app shows "Wrong cluster" and won't let me sign**. Your wallet is on mainnet-beta (Phantom's default) but the program is on devnet. Switch the wallet's active network to Devnet. The `<ClusterHint>` banner explains the exact steps per wallet.

**`commit_deck CU: X / 200000` exceeds budget at smoke-test step 4**. The CU regression guard caught a real regression — someone probably re-introduced `light_poseidon`, broke the Groth16 path, or pushed log emission past budget. See [`scripts/smoke-test.ts`](https://github.com/Panmoni/pushflip/blob/main/scripts/smoke-test.ts) comments around `COMMIT_DECK_CU_BUDGET` for the diagnostic chain.

**My changes to a wiki page aren't live-reloading**. Check that `mkdocs serve` is still running in the background. Hit save, wait 1–2 seconds, refresh the browser. If the page is gone from the sidebar, check `wiki/mkdocs.yml`'s `nav:` block — every page must be listed there or the health check will fail.

**Anything else**. Open an issue at [github.com/Panmoni/pushflip](https://github.com/Panmoni/pushflip/issues) or ping the maintainer on Telegram (link in [README](https://github.com/Panmoni/pushflip/blob/main/README.md)).
