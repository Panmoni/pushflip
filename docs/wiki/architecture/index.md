---
title: System Design
diataxis_type: explanation
last_compiled: 2026-04-11
---

# System Design

> **Stub.** This page will be fleshed out in the next commit with the full system overview, components, data flow, ZK pipeline, and performance profile (sourced from the README's "How the ZK System Works" + "Performance and Costs" sections plus the EXECUTION_PLAN's "Project Overview" + "Technical Architecture" sections).
>
> Tracked as part of the wiki commit chain landing 2026-04-11.

## Sections coming

- Overview — what PushFlip is and the trust model in one paragraph
- Components — program (Pinocchio), dealer service, frontend, wallet bridge
- Data flow — how a single round of a game flows through the system
- ZK pipeline — Circom → Groth16 → Poseidon Merkle, off-chain proof generation, on-chain verification
- Performance profile — compute units per instruction, rent costs, latency profile
- Trust model summary — single-dealer assumption, links to [Threat Model](threat-model.md)

For now, the canonical source for this material is the repository [README](../../../README.md) and the [Project History](../history/index.md) execution plan.
