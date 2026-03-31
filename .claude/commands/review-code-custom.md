# Code Review (Custom Scope)

Perform a code review of the specified files. Replace **FILES_OR_SCOPE** below with the paths you want reviewed (e.g. `src/lib.rs` or a short list of files), or pass them as the command argument. $ARGUMENTS

**Scope:** FILES_OR_SCOPE

## Focus

1. **Correctness:** Logic errors, edge cases, null/undefined handling, error handling.
2. **Consistency:** Naming, structure, and patterns match the rest of the codebase.
3. **Maintainability:** Clarity, duplication, appropriate abstraction, comments where needed.
4. **Tests:** Are there or should there be tests; are they sufficient?
5. **Documentation:** README, inline comments accurate and up to date?
6. **No regressions:** Changes don't break existing behavior or contracts.

## Output

- List findings with **severity** (High / Medium / Low), **file and location**, and a **concrete recommendation** for each.
- End with a short summary and whether you recommend changes before merge.
