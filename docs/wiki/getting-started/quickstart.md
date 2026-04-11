---
title: Quickstart
diataxis_type: tutorial
last_compiled: 2026-04-11
status: stub
---

# Quickstart

> **Stub.** This page is a placeholder so the navigation is structurally complete. The minimum-viable quickstart instructions live in two places today: the [`Contributing`](contributing.md) page wraps the project's [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) (which has the toolchain prereqs and build commands), and the [`README`](../../../README.md) has the deploy-from-source walkthrough.
>
> Tracked as a documentation debt follow-up in [`docs/EXECUTION_PLAN.md`](../../EXECUTION_PLAN.md) under "Documentation Debt". Will be fleshed out into a single end-to-end zero-to-running tutorial in a follow-up session.

## What this page will eventually cover

- Prerequisites table — Rust 1.84+, Solana CLI, Node 20.11+ + pnpm 9+, Python 3.12 (for the wiki), one funded devnet keypair
- One-time setup: clone, `pnpm install`, build the on-chain program with `cargo build-sbf --manifest-path program/Cargo.toml`
- First-time devnet wallet setup: `solana airdrop 2`, verify with `solana balance`
- Run the smoke test end-to-end: `pnpm --filter @pushflip/scripts smoke-test`
- Initialize a persistent test game at `game_id=1`: `pnpm --filter @pushflip/scripts init-game` (the substrate the frontend reads from)
- Start the dev server: `pnpm --filter @pushflip/app dev` and connect a wallet to `http://localhost:5173`
- Local wiki preview: `mkdocs serve -f wiki/mkdocs.yml`

## Today, do this

1. Read [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) at the repo root
2. Run the workspace verification gates from the project [README](../../../README.md) "Quickstart" section
3. If anything is unclear, file an issue against the repo
