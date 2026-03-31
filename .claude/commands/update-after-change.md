# Update After Change (Docs, Lint, Tests)

Run this **before committing**: after you make code changes (new features, fixes, refactors), run this to update documentation, fix lints, and run tests. Then use **Propose Commits** to commit everything together so each commit is complete.

## What to Keep Updated

When you change code, update as needed:

| Area | What to do |
|------|------------|
| **Documentation** | Update README(s), `docs/`, and inline comments in the touched area. |
| **Formatting** | Run `cargo fmt` to ensure consistent formatting. |
| **Linting** | Run `cargo clippy` and fix new warnings. Do not leave new warnings introduced by the change. |
| **Tests** | Add or adjust tests for new/changed behavior; run related tests. |
| **Types / Build** | Run `cargo build` and fix any compilation errors. |
| **IDL** | If you changed instructions or accounts, regenerate the Shank IDL and Codama client. |

## Steps (in order)

1. **Identify what changed**
   - Use unstaged and untracked paths as the change set: `git diff --name-only` and `git ls-files --others --exclude-standard`.
   - Note: new or changed instructions, accounts, token operations, ZK verification logic.

2. **Documentation**
   - For each touched area, update the relevant docs.
   - If instructions or account layouts changed: update any docs describing the on-chain interface.
   - If client code changed: update relevant docs in `docs/`.

3. **Format and Lint**
   - Run: `cargo fmt --all`
   - Run: `cargo clippy --all-targets --all-features -- -D warnings`
   - Fix any new warnings or errors. Do not suppress warnings with `#[allow(...)]` unless there is a clear justification.

4. **Build**
   - Run: `cargo build --all-targets`
   - Fix any compilation errors before proceeding.

5. **Tests**
   - Identify test files related to the change (by name match or module).
   - Run related tests: `cargo test <test_name_or_module>`
   - If the change is broad, run the full suite: `cargo test`
   - Add tests for new behavior where appropriate.
   - Ensure no new test failures are introduced.

6. **IDL (if applicable)**
   - If instruction or account definitions changed, regenerate the IDL with Shank.
   - If the IDL changed, regenerate the TypeScript client with Codama.

## Commands reference

- Format: `cargo fmt --all`
- Lint: `cargo clippy --all-targets --all-features -- -D warnings`
- Build: `cargo build --all-targets`
- Test (specific): `cargo test <name>`
- Test (all): `cargo test`
- Check (fast compile check): `cargo check --all-targets`

## Output

- Summarize what you updated (docs, lint fixes, test changes).
- List any remaining warnings or failing tests that need manual follow-up.
- If you did not change something (e.g., IDL, client), say so briefly so the user can decide to do it manually.
