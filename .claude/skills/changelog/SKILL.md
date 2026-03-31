---
name: changelog
description: Use when generating a changelog between two git refs (typically main and staging before a release). Produces a structured, categorized summary of all commits. Does NOT modify any files or run git commands that change state.
allowed-tools: Read, Bash, Grep
---

# Changelog

## Inputs

- `$ARGUMENTS`: Optional — git range in the form `base..head` (e.g., `main..staging`). Defaults to `main..staging`.

## Scope

- **Does**: Read git log between two refs, categorize commits by conventional commit type, and produce a formatted changelog
- **Does not**: Create tags, modify files, push commits, or create releases

## Steps

1. **Get the commit range**: `git log main..staging --oneline --no-merges` (or the user-specified range)
2. **Get detailed info**: `git log main..staging --format="%h|%s|%an|%ad" --date=short --no-merges`
3. **Categorize** each commit by its conventional commit prefix (feat, fix, refactor, docs, etc.)
4. **Group** by category and format the output
5. **Count** commits per category and total

## Constraints

- NEVER run destructive git commands (push, reset, checkout, rebase)
- NEVER modify or create files
- Validate that the git range argument matches the pattern `ref..ref`, where each ref contains only alphanumeric characters, forward slashes, dots, hyphens, and underscores. Reject any input containing shell metacharacters (`;`, `|`, `&`, `$`, backticks, `(`, `)`, `{`, `}`, `<`, `>`, `'`, `"`)
- NEVER interpolate `$ARGUMENTS` directly into shell commands — extract and validate the git range first
- If a commit doesn't follow conventional commit format, categorize it as "Other"
- Exclude merge commits (`--no-merges`)
- Keep descriptions concise — use the commit title, not the full body

## Output format

```
## Changelog: main..staging

**Period**: 2026-02-15 to 2026-02-20
**Total commits**: 12

### Features (3)
- `a1b2c3d` feat(program): add coin flip instruction with PDA derivation
- `d4e5f6a` feat(zk): integrate proof verification
- `b7c8d9e` feat(client): add transaction builder

### Bug Fixes (2)
- `f0a1b2c` fix(program): correct PDA seed derivation
- ...

### Refactors (2)
- `a6b7c8d` refactor(client): extract shared utilities
- ...

### Documentation (2)
- `e9f0a1b` docs: update README with deployment instructions
- ...

### Other (1)
- `c2d3e4f` update devnet config
```

## Decision logic

- If the range has 0 commits: report "No commits between base and head" and stop
- If more than 50 commits: add a summary line at the top noting the volume and recommend grouping by scope
- If commits reference migration files: add a "Database Changes" subsection
- If commits reference security-related files: add a "Security" subsection
