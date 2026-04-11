---
title: Threat Model
diataxis_type: explanation
last_compiled: 2026-04-11
status: stub
related_wiki:
  - architecture/index.md
  - reference/faq.md
---

# Threat Model

> **Stub.** This page is a placeholder so the navigation is structurally complete. The security analysis currently lives scattered across the [README "Known Limitations"](https://github.com/Panmoni/pushflip/blob/main/README.md) section, the [FAQ](../reference/faq.md) Q9–Q17 (the "Probing/Critical" tier), and the [Project History → Execution Plan](../history/index.md) Pre-Mainnet Checklist.
>
> Tracked as a documentation debt follow-up in [`docs/EXECUTION_PLAN.md`](https://github.com/Panmoni/pushflip/blob/main/docs/EXECUTION_PLAN.md) under "Documentation Debt". Will be consolidated into a single coherent threat model in a follow-up session — most likely after the threshold-randomness rework lands (Pre-Mainnet 5.0.2), since that's when the trust assumptions actually change.

## What this page will eventually cover

- **Trust assumptions** — what each role (authority, dealer, House, treasury, players) is trusted to do, and what happens if any of them is compromised
- **Attack surface** — every signer, every CPI, every account that can be passed by the client, and the validation that protects each
- **The single-trusted-dealer assumption** — what the ZK proof does and does NOT prove (it proves *valid permutation*, not *random shuffle*)
- **Cross-game proof reuse** — Groth16 proofs are not bound to a `game_id` (only `(merkle_root, canonical_hash)` are public inputs); the dealer must not reuse shuffles. Tracked as part of Pre-Mainnet 5.0.2.
- **`vault_ready` runtime check** — why it's not stored, and how a missing token account at the vault PDA gracefully degrades to no-stake mode
- **Heavy-duty review history** — every pre-shipping security review and what each one caught (cross-game claim exploit, authority gating, double-click double-spend, BigInt-u64 silent wrap)
- **Out-of-scope threats** — wallet compromise, RPC MITM, social engineering on the deployer, browser extension attacks
- **Mitigations status** — fixed, deferred to mainnet, accepted

## Today, read

- [README "Known Limitations"](https://github.com/Panmoni/pushflip/blob/main/README.md) — high-level
- [FAQ Q9–Q17](../reference/faq.md) — the "Probing/Critical" tier covers most security concerns
- [`docs/EXECUTION_PLAN.md`](https://github.com/Panmoni/pushflip/blob/main/docs/EXECUTION_PLAN.md) → **Lessons Learned** section, especially #42 (BigInt footgun) and #43 (wallet bridge byte-level verification)
- [`docs/EXECUTION_PLAN.md`](https://github.com/Panmoni/pushflip/blob/main/docs/EXECUTION_PLAN.md) → **Pre-Mainnet Checklist** items 5.0.2 (threshold randomness) and 5.0.3 (final security review pass)
