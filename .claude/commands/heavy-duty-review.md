# Recursive 3-Pass Security & Code Review

Perform a comprehensive security and code quality review using a 3-pass recursive methodology: Discovery → Verification → Synthesis. Each pass builds on the previous to maximize finding rate while minimizing false positives. $ARGUMENTS

## Scope

Determine what to review based on `$ARGUMENTS`:

1. **File paths or directories provided** → review those files
2. **"diff" or "branch"** → review files changed on the current branch vs main: `git diff main...HEAD --name-only`
3. **"staged"** → review staged changes: `git diff --cached --name-only`
4. **No arguments** → review the full `src/` directory (or equivalent project root)

If the scope exceeds 200 source files, split into chunks of ~80 files (grouped by directory) and process each chunk through the full 3-pass pipeline, then merge the final reports.

---

## Step 0: Context Gathering

Before starting review passes, establish project context:

1. **Detect project**: Read `CLAUDE.md` in the repo root to understand the tech stack, framework, conventions, and security requirements. If no CLAUDE.md, read `README.md` and `Cargo.toml` (or `package.json`).

2. **Read the schema** (if applicable): If this is a program with account layouts, read the account definitions to understand the data model. This is required for accurate account validation and data integrity analysis.

3. **Establish threat model**: Adapt review priorities to the project type:
   - **Solana program (on-chain)**: Account validation, signer checks, PDA safety, arithmetic overflow, CPI security, token handling, ZK proof verification
   - **Client/frontend**: Secrets in client bundles, transaction construction safety, wallet interaction security
   - **Scripts/tools**: Command injection, secrets management, key handling

---

## PASS 1: DISCOVERY (Parallel Subagents)

Launch **3 parallel Explore subagents** in a single message. Each scans the full scope independently and returns raw findings. Be over-inclusive — it is better to flag something questionable than miss it.

### Agent A: Security Scan

Prompt the Explore agent with:

> Perform a security audit of the following files. For each finding, report: file path, line number(s), issue description, and severity estimate (Critical/High/Medium/Low). Be thorough — flag anything suspicious.
>
> **Check for:**
> 1. **Account Validation**: Missing owner checks, missing signer checks, missing writable checks, unchecked account keys, PDA seed collisions, accepting arbitrary program IDs in CPI
> 2. **Arithmetic Safety**: Integer overflow/underflow without checked math, unsafe casting between integer types, precision loss in token amount calculations
> 3. **CPI Security**: Missing program ID verification before invoke, unchecked return values from CPI, privilege escalation via CPI, reentrance risks
> 4. **Secrets & Credentials**: Hardcoded keys, tokens, or seeds in source code; secrets in logs or error messages; private keys in client bundles
> 5. **Input Validation**: Missing or insufficient validation on instruction data, malformed account data handling, deserialization panics
> 6. **Token Safety**: Missing mint/authority validation on SPL token accounts, unchecked token decimals, missing freeze authority checks
> 7. **ZK Proof Security**: Proof verification bypasses, weak or missing public input validation, proof malleability
> 8. **Data Exposure**: Sensitive data in on-chain account data that should be private, verbose error messages exposing internals
> 9. **Dependency & Supply Chain**: Known vulnerable crates, overly permissive version ranges, unsafe feature flags
>
> Files to scan: {SCOPE_FILES}

### Agent B: Program Logic & Data Integrity Scan

Prompt the Explore agent with:

> Analyze the following files for program logic correctness and data integrity issues. For each finding, report: file path, line number(s), issue description, and severity (Critical/High/Medium/Low).
>
> **Check for:**
> 1. **State Machine Violations**: Invalid game state transitions, missing state checks before actions, state changes without proper guards, orphaned accounts in intermediate states
> 2. **Token Economics**: Incorrect stake/burn amounts, missing escrow validation, token drain paths, incorrect mint authority usage
> 3. **PDA Integrity**: Wrong seeds producing wrong PDAs, bump seed not stored/verified, PDA reuse across different contexts
> 4. **Randomness & Fairness**: Predictable randomness sources, manipulable inputs to randomness, front-running opportunities, incomplete ZK verification allowing deck manipulation
> 5. **Account Lifecycle**: Missing account initialization checks, double-initialization, accounts not properly closed/reclaimed, rent-exempt balance not maintained
> 6. **Instruction Ordering**: Assumptions about instruction ordering that can be violated, missing checks for atomic multi-instruction transactions
> 7. **Edge Cases**: Zero-amount handling, maximum value overflow, empty/null in required fields, off-by-one on array boundaries
> 8. **Audit Trail Gaps**: Missing events/logs for critical state changes, insufficient data for off-chain indexing
>
> Files to scan: {SCOPE_FILES}

### Agent C: Code Quality, Performance & Configuration Scan

Prompt the Explore agent with:

> Review the following files for code quality, performance, and configuration issues. For each finding, report: file path, line number(s), issue description, and severity (High/Medium/Low).
>
> **Check for:**
> 1. **Logic Errors**: Off-by-one errors, wrong comparison operators, inverted conditions, unreachable code, match/if-else with missing cases, unsafe unwrap on fallible operations
> 2. **Error Handling**: Panics in production code paths (unwrap, expect without justification), errors swallowed silently, missing error propagation, catch-all that masks specific errors
> 3. **Type Safety**: Unsafe transmute or pointer casts, unchecked type conversions, missing lifetime annotations causing potential UB
> 4. **Compute Budget**: Operations that may exceed compute limits, unnecessary allocations in hot paths, redundant deserialization, unbounded loops
> 5. **Serialization**: Borsh serialization/deserialization mismatches, account data layout changes without migration, buffer size miscalculations
> 6. **Unsafe Code**: Unnecessary unsafe blocks, soundness holes in unsafe code, missing safety comments
> 7. **Configuration**: Debug code in production paths, hardcoded cluster-specific values, missing feature flags for devnet vs mainnet
> 8. **Dead Code & Maintainability**: Unused functions/modules, unreachable branches, copy-paste duplication that creates maintenance risk
>
> Files to scan: {SCOPE_FILES}

**Wait for all 3 subagents to complete. Collect all raw findings.**

---

## PASS 2: VERIFICATION (False-Positive Filtering)

Process all findings from Pass 1 through two filters.

### Filter 1: Hard Exclusions (auto-dismiss without further analysis)

Dismiss findings that match ANY of these patterns — do not report them:

- **Test-file-only issues**: Findings in `tests/`, `__tests__/`, `*.test.rs` — UNLESS they contain real credentials or connect to production endpoints
- **DoS / resource exhaustion**: Missing rate limiting, compute exhaustion — these are operational concerns handled at the infrastructure layer, not code review findings
- **Console/log output in scripts/CLI tools**: Scripts and migration tools are allowed to log. Only flag logging that leaks secrets or private keys.
- **Intentional development/debug code**: Code explicitly gated behind feature flags or environment checks
- **Missing validation on internal-only functions**: Functions only called from other validated code paths (trace the call chain before flagging)

### Filter 2: Confidence Scoring & Context Verification

For each remaining finding, assign a confidence level:

**90-100% (HIGH)**: Clear, unambiguous issue with an obvious exploit or failure path. No additional context needed. Keep as-is.

**70-89% (MEDIUM)**: Likely issue but depends on context. **Read the surrounding code** (20+ lines above and below, plus callers/callees) to verify:
- Is the input actually user-controlled, or is it from a trusted internal source?
- Is there validation upstream that the subagent missed?
- Is there a wrapper or framework guard handling this concern?
- Does the framework already handle this (e.g., Pinocchio entrypoint parsing)?

If context confirms the issue → keep. If context shows it is mitigated → dismiss with a one-line reason.

**Below 70% (LOW)**: Speculative or theoretical. **Dismiss** — unless the finding involves:
- Token movement, balance changes, or escrow operations → keep and verify
- Account validation bypass or key exposure → keep and verify
- ZK proof verification integrity → keep and verify
- All other low-confidence findings → dismiss

**Output of Pass 2**: A filtered list where each finding has: file, line range, description, severity, confidence percentage, and verification status (confirmed/dismissed/context-verified).

---

## PASS 3: SYNTHESIS (Ranking, Cross-Cutting Analysis, Final Report)

### Step A: Cross-Cutting Analysis

Before writing the final report, look for systemic patterns:

1. **Common root causes**: Are multiple findings symptoms of the same underlying gap? (e.g., multiple missing signer checks → inconsistent account validation pattern)
2. **Missing patterns**: Are entire categories of code missing a security practice? (e.g., no owner checks anywhere, no checked math anywhere)
3. **Compound vulnerabilities**: Do two or more individually-medium findings combine into a critical vulnerability? (e.g., missing signer check + token transfer = unauthorized drain)
4. **Positive patterns**: What security and quality practices are done well? Acknowledge these — the report should not be purely negative.

### Step B: Fresh-Eyes Final Pass

Re-read the full scope (or diff) one more time with fresh perspective. Specifically look for:
1. Issues you missed in Pass 1 — the deep context from Pass 2 may reveal new patterns
2. Interactions between findings that create compound vulnerabilities
3. Whether any dismissed findings should be reconsidered given the full picture

Tag any new findings as `[LATE FIND]`.

### Step C: Generate Final Report

```
## Recursive Security & Code Review Report

**Scope**: {files/directories reviewed}
**Project**: {repo name} ({tech stack})
**Date**: {today}
**Method**: 3-pass recursive (Discovery → Verification → Synthesis)

---

### Critical Findings (block merge/deploy)

| # | Confidence | Location | Finding | Remediation |
|---|------------|----------|---------|-------------|
| 1 | 95% | `path/file.rs:42-58` | Description of the issue | Specific code fix or approach |

### High Findings (fix before next deploy)

| # | Confidence | Location | Finding | Remediation |
|---|------------|----------|---------|-------------|

### Medium Findings (address soon)

| # | Confidence | Location | Finding | Remediation |
|---|------------|----------|---------|-------------|

### Systemic Patterns

{Cross-cutting issues affecting multiple files or representing architectural gaps. Each pattern should reference the specific findings it connects.}

### Positive Observations

{Security and quality practices that are done well. Acknowledge good patterns — this builds trust in the report and helps the team know what to keep doing.}

### Review Statistics

- Files scanned: {count}
- Raw findings (Pass 1): {count across all 3 agents}
- After verification (Pass 2): {count}
- Final reported: {n} Critical, {n} High, {n} Medium
- False positive rate: {percentage eliminated in Pass 2}
- Late finds (Pass 3): {count}

### Verdict

{One of:}
- SAFE — No critical or high findings. Safe to merge/deploy.
- CAUTION — No critical findings, but high findings need attention before deploy.
- BLOCK — Critical findings present. Do not merge until resolved.

{One-paragraph summary of the most important takeaway from this review.}
```

---

## Rules

- **Confidence threshold**: Only report findings with 70%+ confidence. Do not pad the report with speculation.
- **Concrete remediations required**: Every finding MUST include a specific fix — not "consider fixing" but the exact code change, pattern, or approach.
- **Token/escrow auto-escalation**: Any finding that could cause incorrect token movement, unauthorized drain, or escrow bypass is automatically Critical severity regardless of confidence score.
- **Read before reporting**: Do not report any finding below 90% confidence without reading the actual code context. No grep-match-only findings.
- **Respect existing patterns**: If the codebase uses a specific library or pattern, recommend using it rather than suggesting alternatives.
- **Cap at 100 findings**: If Pass 1 produces more than 100 raw findings, prioritize by severity and confidence during Pass 2. The report should be actionable, not overwhelming.
- **Do not re-review test code**: Test files are not in scope unless they contain real credentials or secrets.
- **Preserve the team's time**: Every finding should be worth the engineer's time to read. If you are unsure whether something is worth reporting, err on the side of including it only if it involves security or token operations.
