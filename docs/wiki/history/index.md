---
title: Project History
diataxis_type: explanation
last_compiled: 2026-04-11
---

# Project History

PushFlip is built in phases. The full story — every decision, every lesson learned, every retrospective — lives in a single living document at the repository root.

## The execution plan

**[`docs/EXECUTION_PLAN.md`](https://github.com/Panmoni/pushflip/blob/main/docs/EXECUTION_PLAN.md)** — 3,200+ lines covering:

- Project overview and scope
- Technical architecture and data model
- Phase-by-phase task breakdown (Phases 1, 2, 3A, 3B, 4, 5)
- Decisions log with rationale and trade-offs
- Lessons learned across the build, organized by topic (tooling, ZK, Pinocchio, deployment, process, frontend, hooks & wallet bridge)
- Current status snapshot (updated end-of-session)
- Heavy-duty review history (each one caught at least one structural bug the unit tests missed)
- Pre-mainnet checklist of deferred items

**Why it's not duplicated here:** the execution plan is actively maintained and updated end-of-session by whoever last touched the project. Mirroring it into the wiki tree would create two sources of truth that drift. Instead, the wiki links out, and the execution plan is the single home.

## Retrospectives

Specific incident retrospectives have their own pages:

- **[Poseidon Stack Warning](poseidon-stack-warning.md)** — the BPF stack overflow incident where `light_poseidon` consumed 211K compute units and overflowed the stack frame, and the migration to Solana's native `sol_poseidon` syscall that cut it to 7,771 CU.

## Wiki maintenance

This wiki itself was added to the project on 2026-04-11. The history page is the canonical place to track future restructuring decisions about the docs surface.
