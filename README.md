<h1 align="center">
  <a href="https://pushflip.xyz">
    <img src="docs/wiki/assets/logo.svg" alt="PushFlip" width="240">
  </a>
</h1>

<p align="center">
  A crypto-native push-your-luck card game on Solana. Stake tokens, burn for power,<br>
  and play against an AI-driven House — all with provably fair shuffling via ZK proofs.
</p>

<p align="center">
  <a href="https://pushflip.xyz"><strong>pushflip.xyz</strong></a> ·
  <a href="https://github.com/Panmoni/pushflip-www">website source</a> ·
  <a href="docs/wiki/index.md">wiki</a>
</p>

> 📚 **Full documentation lives in the wiki at [`docs/wiki/`](docs/wiki/index.md)**.
> Architecture, glossary, FAQ, deployment runbooks, ZK research survey, and the project execution plan all live there. This README is a landing page that funnels you into the relevant section.

## What It Is

PushFlip is an on-chain card game with hit/stay mechanics, a `$FLIP` token economy, and zero-knowledge proof deck verification. Every shuffle is provably fair using Groth16 + Poseidon Merkle trees — no trust required.

## Built With

- **Pinocchio** — zero-dependency native Rust on Solana (no Anchor)
- **ZK-SNARKs** — Groth16 proofs for provably fair deck shuffling
- **`$FLIP` Token** — SPL token with stake-to-play and burn-for-power mechanics
- **`@solana/kit`** — modern Solana TypeScript SDK (v6)
- **React + Vite** — frontend
- **Hand-written TypeScript client** — direct mirror of Pinocchio's manual byte layouts (no Shank / Codama indirection)
- **MkDocs Material** — wiki at `docs/wiki/`, served locally with `mkdocs serve -f wiki/mkdocs.yml`

## Features

- On-chain game sessions with PDA-managed state
- AI opponent ("The House") that plays autonomously
- ZK-verified deck commitment — cards are revealed progressively with proof
- Token staking and burning integrated into gameplay
- Flip Advisor — real-time probability assistant

## Quick Links

| If you want to... | Go to |
|---|---|
| Understand the architecture and ZK pipeline | [Wiki → Architecture / System Design](docs/wiki/architecture/index.md) |
| Look up a term | [Wiki → Architecture / Glossary](docs/wiki/architecture/glossary.md) |
| Read the FAQ (17 Q&A across two difficulty tiers) | [Wiki → Reference / FAQ](docs/wiki/reference/faq.md) |
| Onboard as a contributor | [Wiki → Getting Started / Contributing](docs/wiki/getting-started/contributing.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| Read the full project history + decisions log | [`docs/EXECUTION_PLAN.md`](docs/EXECUTION_PLAN.md) |
| Deploy or upgrade the on-chain program | [Wiki → Operations](docs/wiki/operations/index.md) (deployment runbook coming) |
| See the ZK landscape and rationale | [Wiki → Reference / ZK Research](docs/wiki/reference/zk-research.md) |

## Live Devnet Deployment

| Field | Value |
|---|---|
| **Program ID** | `HQLeAQc84WLz8buHM5JAJGBjNJjwc6Fpxts8jSMaW3px` |
| **Cluster** | Devnet |
| **Loader** | BPF Loader Upgradeable |
| **First deployed** | 2026-04-09 |
| **Test mint (`$FLIP`)** | `2KqqB7SRVaD98ZbVaiRWirxbaJv5ryNzkDRGweBZVryF` |
| **Test GameSession (`game_id=1`)** | `Hk6RLHBZ8oppV4KtQFFRsHC21z9tCL5HYz3cLELEA64A` |

Inspect on-chain:

```bash
solana program show HQLeAQc84WLz8buHM5JAJGBjNJjwc6Fpxts8jSMaW3px --url devnet
```

For the full deployment + upgrade runbook see [Wiki → Operations](docs/wiki/operations/index.md).

## Performance teaser

A single turn costs you about **one tenth of one cent** in Solana fees. A full 4-player, ~7-turn game lands at ~3.4 ¢ in non-recoverable transaction fees. The Groth16 proof verification on-chain consumes ~85K compute units; each `hit` consumes ~7,771 CU thanks to Solana's native `sol_poseidon` syscall. End-to-end wall clock for a full game: ~50 seconds.

For the full performance breakdown — per-instruction CU costs, per-account rent, latency profile, and the story of how `sol_poseidon` cut `hit` from 211K CU to 7,771 CU — see [Wiki → Architecture / System Design § Performance Profile](docs/wiki/architecture/index.md#performance-profile) and [Wiki → Project History / Poseidon Stack Warning](docs/wiki/history/poseidon-stack-warning.md).

## Contributing

Outside contributors are welcome. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) for project status, build/test commands, code conventions, and three well-scoped open work tracks (native Rust dealer with arkworks, threshold randomness protocol, House AI agent in Rust). Each track is self-contained and can be owned end-to-end.

For wiki contributions specifically, see [Wiki → Getting Started / Contributing](docs/wiki/getting-started/contributing.md).

## Development

This repo is AI-assisted via Claude Code and ships a set of safety hooks (protected-file guards for program keypairs / ZK artifacts / [`notes.md`](notes.md), blocked-command patterns for irreversible Solana and git operations, auto-format, `cargo check` feedback after edits, and a pre-PR test gate). See [Wiki → Operations / Claude Hooks](docs/wiki/operations/claude-hooks.md) for the full list.

## License

Copyright 2026 George Donnelly and Alex Ramirez, the PushFlip developers

Licensed under the [Apache License, Version 2.0](LICENSE) (the "License"). You may not use this project except in compliance with the License. Unless required by applicable law or agreed to in writing, the software is distributed on an "AS IS" basis, without warranties or conditions of any kind, either express or implied. See the [LICENSE](LICENSE) file for the specific language governing permissions and limitations under the License.

Contributions submitted to this project are licensed under the same Apache License 2.0 by virtue of Section 5 of the License ("inbound = outbound"). No separate Contributor License Agreement is required.

"PushFlip" and "`$FLIP`" are not registered trademarks. Per Section 6 of the License, the Apache License does not grant permission to use the project name or token symbol for purposes other than reasonable and customary use in describing the origin of the work.
