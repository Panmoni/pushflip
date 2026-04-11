---
title: Dealer Runbook
diataxis_type: how-to
last_compiled: 2026-04-11
status: stub
related_wiki:
  - operations/hosting-and-rpc.md
  - architecture/index.md
---

# Dealer Runbook

> **Stub.** This page is a placeholder so the navigation is structurally complete. The dealer service has not yet been deployed to production — it currently runs only as part of the smoke test pipeline ([`scripts/smoke-test.ts`](../../../scripts/smoke-test.ts)) and the unit tests in [`dealer/`](../../../dealer/). A real operational runbook is premature until the service is actually running 24/7 against devnet (and eventually mainnet).
>
> Tracked as a documentation debt follow-up in [`docs/EXECUTION_PLAN.md`](../../EXECUTION_PLAN.md) under "Documentation Debt". Will be written when the dealer first deploys to production infrastructure (Phase 4 or 5).

## What this page will eventually cover

- **Deployment topology** — where the dealer runs (VPS, container, etc.), how it's monitored, what the upstream RPC dependency is. See [Hosting & RPC](hosting-and-rpc.md) for the sizing analysis.
- **Environment setup** — required env vars, SSL certs, snarkjs WASM + zkey paths, the dealer's signing keypair location and rotation procedure
- **Process management** — systemd unit / Docker container / process supervisor of choice; restart policy; log rotation
- **Health checks** — what `/health` should return, what to monitor, expected latencies
- **Snarkjs parameters** — proving key path, witness generator path, expected memory footprint (~4GB for the 362K-constraint circuit), expected wall-clock per proof (~20s on a single core)
- **Error recovery** — what to do when the dealer falls behind (proof generation backlog), how to safely re-key, how to migrate to a new instance with zero on-chain disruption
- **Failure modes** — proof generation OOM, RPC disconnect mid-`commit_deck`, blockhash expiry, dealer keypair compromise
- **Observability** — what logs to ship, what metrics to graph (proof generation latency, instructions sent/sec, RPC error rate)
- **Disaster recovery** — keypair rotation procedure, what to do if the dealer-signed `commit_deck` lands but the off-chain proof state is lost

## Today

The dealer is exercised end-to-end via the smoke test:

```bash
pnpm --filter @pushflip/scripts smoke-test
```

This runs the full lifecycle (initialize → join × 2 → shuffle + Groth16 proof gen → commit_deck → start_round → hit → stay → end_round → leave_game → close_game) against devnet, and is the regression guard for the [`sol_poseidon` syscall](../architecture/glossary.md#sol_poseidon-syscall) integration. See [Project History → Poseidon Stack Warning](../history/poseidon-stack-warning.md) for the incident that made that test critical.

For sizing and cost analysis of running the dealer in production, see [Hosting & RPC](hosting-and-rpc.md).
