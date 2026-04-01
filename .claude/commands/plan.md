Use when planning a feature, program design decision, integration, or phased milestone for pushflip before writing code. Builds a concrete, stress-tested plan grounded in the project's Solana architecture, on-chain constraints, and ZK complexity. Does NOT write code — produces a plan the user approves before work begins. $ARGUMENTS

## Context

This is **pushflip** — a crypto-native push-your-luck card game on Solana. Pre-development / planning phase (docs only, no code yet). Key references: `docs/EXECUTION_PLAN.md` (roadmap), `docs/PINOCCHIO_RESOURCE_GUIDE.md` (program framework), `docs/SOLANA_KIT_GUIDE.md` (frontend chain interaction), `docs/ZK_RESEARCH.md` (proof system research).

Stack: Pinocchio (native Rust on-chain program, zero Anchor), Groth16 + Poseidon Merkle trees (ZK deck shuffles), $FLIP SPL token, Shank (IDL) + Codama (TypeScript client), Vite + React + @solana/kit.

Priority hierarchy: **on-chain correctness > exploit resistance > ZK feasibility > token economic integrity > developer experience**.

## Workflow

### Step 0: Understand the goal

Parse `$ARGUMENTS` or conversation context to identify:
- **What** they want to design (on-chain instruction, account structure, ZK circuit, token mechanic, frontend flow, phased milestone)
- **Why** it matters (MVP unblocking, game mechanic, fairness guarantee, token utility, exploit prevention)
- **Scope** — which layers are touched (on-chain program, ZK circuits, SPL token, frontend, off-chain oracle/house backend)

If the goal is vague, ask pointed questions before proceeding. Don't plan against guesses.

### Step 1: Clarify the end state

Define "done" concretely:
- What observable on-chain state changes? (accounts created/modified, instructions invoked, events emitted)
- What is the single most important acceptance criterion?
- Does this touch player funds or token burns? Every fund-moving instruction must be atomic and exploit-resistant.
- On-chain vs off-chain boundary: which logic MUST be on-chain for trustlessness, and what can safely live off-chain?

### Step 2: Map the architecture

Read the relevant docs to ground the plan. Key references:

| Domain | Reference |
|--------|-----------|
| Roadmap / phasing | `docs/EXECUTION_PLAN.md` |
| Program primitives | `docs/PINOCCHIO_RESOURCE_GUIDE.md` |
| Frontend / RPC | `docs/SOLANA_KIT_GUIDE.md` |
| ZK proofs | `docs/ZK_RESEARCH.md` |

Key design questions to resolve per domain:

**On-chain program (Pinocchio)**
- Which accounts does this instruction read/write? Define each: type (PDA vs. wallet vs. mint), seeds, size (bytes), ownership, mutability.
- Which PDAs are involved? Document full seed derivation (`[program_id, discriminator, ...]`).
- What is the instruction discriminator and argument layout?
- What CU budget does this realistically consume? Flag if approaching 200k CU limit.

**ZK integration**
- Is ZK required for trustlessness here, or is it a nice-to-have? Be explicit.
- Which proof system? (Groth16 for deck shuffle; simpler alternatives if CU cost is prohibitive.)
- Where does proof generation happen? (client browser, off-chain prover, house server)
- Where does proof verification happen? (on-chain via syscall, off-chain with on-chain hash commitment)
- Estimated on-chain verification CU cost — reference `docs/ZK_RESEARCH.md` for current benchmarks.

**Token ($FLIP SPL)**
- Does this instruction stake, burn, or transfer $FLIP? Specify the exact token account flow.
- Are burn-for-power mechanics involved? Confirm they are irreversible on-chain.
- What prevents a player from exploiting the token mechanic (e.g., stake → lose → reclaim race)?

**Frontend**
- Which @solana/kit primitives are used? (transaction builders, account fetching, simulation)
- What is the optimistic UI state vs. confirmed on-chain state?
- What happens if the transaction fails after the user signs?

Search Open Brain for related decisions:
```
brain_search(query="<relevant keywords>", source="pushflip")
```

### Step 3: Map constraints

State explicitly:

- **Compute units**: Solana base limit 200k CU per transaction; Groth16 verification alone can consume 50-150k CU. Budget every instruction.
- **Account size limits**: Max account size 10 MB; reallocating accounts costs lamports. Size accounts correctly at creation — undersizing is painful to fix post-deploy.
- **Rent exemption**: All accounts must be rent-exempt. Calculate required lamports at creation.
- **PDA collision resistance**: Ensure seed uniqueness across game sessions, players, and rounds.
- **Upgrade authority**: Is the program upgradeable? Lock down upgrade authority post-launch or keep it for iteration — decide explicitly.
- **ZK proving time**: Client-side Groth16 proof generation can take 5-30s. Is this acceptable UX for the game loop?
- **Front-running / MEV**: Any instruction where outcome depends on ordering is exploitable. Commit-reveal or ZK shuffle mitigates this — confirm which.
- **Token economics**: Burns are permanent. Stake-release timing must be atomic with game outcome settlement.
- **Phasing**: Reference `docs/EXECUTION_PLAN.md` — is this MVP scope, or a later phase? Don't over-engineer phase 1.

### Step 4: Identify the critical path

Break the work into **3-7 milestones** ordered by dependency. For each milestone:

- **What**: concrete deliverable (Rust source file, account struct, instruction handler, circuit, TypeScript client method)
- **Depends on**: which prior milestones must be complete
- **Parallel?**: can this run alongside other milestones
- **Risk**: what could go wrong here specifically

Common milestone patterns for this project:
1. **Account design** — define account structs, sizes, PDA seeds, discriminators (Shank annotations)
2. **Instruction skeleton** — Pinocchio instruction handler, argument parsing, account validation
3. **Business logic** — game state transitions, token operations, outcome settlement
4. **ZK circuit** — Groth16 circuit design, trusted setup, proof generation harness
5. **On-chain verifier** — integrate ZK verification into instruction handler
6. **IDL + TypeScript client** — run Shank, run Codama, write typed instruction builders
7. **Frontend integration** — @solana/kit transaction construction, simulation, wallet interaction

Flag the **single biggest bottleneck or risk** explicitly (usually ZK CU cost or account size).

### Step 5: Build the plan

For each milestone:

```
Milestone N: [Title]
Depends on: [milestone numbers or "none"]
Files to create/modify:
  - programs/pushflip/src/instructions/foo.rs — what it does
  - programs/pushflip/src/state/bar.rs — account struct
  - circuits/deck_shuffle.circom — ZK circuit
  - clients/src/instructions/foo.ts — Codama-generated or hand-written client
Actions:
  1. [verb] [object] [detail]
  2. ...
On-chain cost estimate:
  - Account size: N bytes, rent: ~X SOL
  - CU estimate: N CU
Test strategy:
  - Program test (bankrun / solana-program-test)
  - Client-side integration test
Risk:
  - What could go wrong and how to detect it
```

### Step 6: Stress test the plan

Challenge against these failure modes:

| Category | Question |
|----------|----------|
| **Compute units** | Does any single instruction exceed 200k CU? Does ZK verification + game logic fit in one tx? |
| **ZK proof cost** | What is the realistic on-chain verification CU? Is an off-chain verify + on-chain commitment hash acceptable fallback? |
| **Front-running / MEV** | Can a validator reorder instructions to know the card outcome before settlement? Is commit-reveal or ZK shuffle fully preventing this? |
| **Token exploits** | Can a player stake, lose, and reclaim tokens in the same block via CPI? Is stake locked atomically until settlement? |
| **Account size** | Is every account sized for its maximum possible data? What happens if a game session exceeds expected size? |
| **Upgrade path** | If the program is upgradeable, can a malicious upgrade drain player funds? Is the upgrade authority multisig? |
| **Concurrency** | Can two game sessions for the same player collide on PDA seeds? Are PDAs globally unique? |
| **Oracle / randomness** | If the house provides randomness off-chain, can it be manipulated? Does ZK commit to the shuffle before reveal? |
| **Observability** | Will we know if an instruction fails silently on-chain? Are events emitted for all state transitions? |

State:
- The **most likely failure mode** and its early warning sign
- The **fallback plan** if the biggest risk materializes (e.g., ZK too expensive → off-chain verify with on-chain Merkle root commitment)
- Which features are **MVP-critical** vs. can be cut for phase 1

### Step 7: Present the plan

Output a structured plan with:

1. **Goal** — one sentence
2. **End state** — what "done" looks like (on-chain state, client behavior, game mechanic)
3. **On-chain / off-chain boundary** — explicit diagram or list of what lives where
4. **Milestones** — ordered list with dependencies, files, CU estimates, and actions
5. **Critical path** — sequential vs. parallel milestones
6. **Biggest risk** — and the mitigation (with fallback)
7. **Open questions** — anything needing user input before starting (e.g., ZK proof system choice, upgrade authority policy, MVP scope cutline)

## Rules

- Do NOT write code — this skill produces a plan only
- Do NOT assume ZK is cheap — always estimate CU cost explicitly and flag if it threatens tx limits
- ALWAYS read the relevant docs in `docs/` before planning; do not rely on training data for Pinocchio or @solana/kit specifics
- ALWAYS check Open Brain for related past decisions before planning
- Be direct. A plan that honestly says "ZK on-chain verification may not fit in one transaction" is more valuable than one that glosses over it
- Flag when a proposed design trades trustlessness for convenience — the user must make that call explicitly
- If the goal is too vague to plan concretely, push back with specific questions rather than planning against guesses
