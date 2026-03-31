---
name: skill-creator
description: Use when the user wants to create, improve, or audit a custom skill (slash command) for Claude Code or Cursor. Produces a production-quality SKILL.md or command .md file that follows proven design standards. Does NOT create skills automatically — only when explicitly asked.
allowed-tools: Read, Glob, Grep, Write, Edit
---

# Skill Creator

Create or improve skills that reliably trigger, produce consistent output, and hold up in real use.

## What this skill does

- Scaffolds a new `.claude/skills/<name>/SKILL.md` or `.claude/commands/<name>.md` file
- Rewrites an existing skill to meet the standards below
- Audits a skill against these standards and reports gaps

## What this skill does NOT do

- Create rules files (use manual editing for `.claude/rules/`)
- Auto-generate skills without the user asking
- Modify CLAUDE.md or project configuration

## Standards checklist — every skill MUST pass these

### 1. Description is a trigger, not a summary
Start the frontmatter `description` with "Use when..." so Claude can pattern-match reliably.

Bad: "Generates database migrations."
Good: "Use when creating a new database migration file. Produces a dated, idempotent SQL migration and updates schema.sql to match."

### 2. Inputs are explicit
State exactly what the user must provide: file paths, scope description, PR number, etc. Use `$ARGUMENTS` for required input. If no arguments are needed, say so.

### 3. Scope is bounded
One sentence on what the skill does. One sentence on what it does NOT do. Prevents accidental activation and scope creep.

### 4. Outcome over activity
Frame the goal as a deliverable, not a process. "Produce a migration file ready for `npm run migrate:test`" beats "Write SQL."

### 5. Success criteria are embedded
Define what "done well" looks like. KPIs if relevant (test pass rate, zero lint errors, etc.).

### 6. Frameworks are hardcoded
If the skill follows a repeatable structure (checklist, decision tree, template), embed it directly. Don't leave it to inference.

### 7. Constraints are explicit
List what the output must NOT contain. "No guessed column names." "No `npm audit fix --force`." "No hardcoded secrets." Constraints separate average from opinionated.

### 8. Output format is defined
Specify the exact format: markdown table, SQL file, code block with language tag, checklist, etc. Without format rules, outputs drift across invocations.

### 9. Examples of good output are included
One short example sharpens quality more than ten rules. Show the expected shape of the deliverable.

### 10. Decision logic is present
What to prioritize. What to skip. What to escalate to the user. Skills that decide produce better results than skills that just produce.

### 11. The skill is focused
One job per skill. If you need two jobs, create two skills. Clarity beats complexity.

### 12. Token budget is respected
Keep SKILL.md under 500 lines. Use `references/` for detailed docs and `scripts/` for executable code. The context window is shared — every token costs.

## Template

```markdown
---
name: <lowercase-hyphenated>
description: Use when <trigger condition>. <What it produces>. Does NOT <boundary>.
---

# <Skill Name>

## Inputs
- `$ARGUMENTS`: <what the user provides>

## Scope
- **Does**: <one sentence>
- **Does not**: <one sentence>

## Steps
1. <Step with concrete action>
2. <Step with concrete action>
3. <Step with concrete action>

## Constraints
- <Hard rule 1>
- <Hard rule 2>

## Output format
<Exact format specification>

## Example output
<Short, concrete example>

## Decision logic
- If <condition>: <action>
- If <condition>: <action>
```
