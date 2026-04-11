# Update After Change (Docs, Lint, Tests)

Run this **before committing**: after you make code changes (new features, fixes, refactors), run this to update documentation, fix lints, and run tests. Then use **Propose Commits** to commit everything together so each commit is complete.

## What to Keep Updated

When you change code, update as needed:

| Area | What to do |
|------|------------|
| **Documentation** | Update README(s), `docs/`, and inline comments in the touched area. |
| **Wiki** | If you touched anything under `docs/wiki/` or `wiki/`, update `last_compiled` frontmatter on every edited page to today's date, then run `bash scripts/wiki-health-check.sh --strict` and `mkdocs build -f wiki/mkdocs.yml --strict`. Fix any warnings about missing/invalid frontmatter, stale pages, broken `related_wiki` refs, or pages omitted from the nav. |
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

2.5. **Wiki verification (only if you touched `docs/wiki/` or `wiki/`)**
   - For every wiki page you edited, set the `last_compiled` frontmatter field to today's date.
   - Run: `bash scripts/wiki-health-check.sh --strict`
   - Run: `mkdocs build -f wiki/mkdocs.yml --strict`
   - Fix: missing or invalid frontmatter (`title`, `diataxis_type`, `last_compiled`), stale `last_compiled` (>60 days), broken `related_wiki` references, pages omitted from `mkdocs.yml`'s `nav:` block.
   - If the wiki Python venv hasn't been set up yet: `python3 -m venv wiki/.venv && wiki/.venv/bin/pip install -r wiki/requirements.txt`. Then prefix the commands above with `wiki/.venv/bin/` so you don't need to activate the venv every time.

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
- Wiki health check: `bash scripts/wiki-health-check.sh --strict`
- Wiki strict build: `wiki/.venv/bin/mkdocs build -f wiki/mkdocs.yml --strict`
- Wiki local serve: `wiki/.venv/bin/mkdocs serve -f wiki/mkdocs.yml` (then open <http://127.0.0.1:8000>)

## Output

- Summarize what you updated (docs, lint fixes, test changes).
- List any remaining warnings or failing tests that need manual follow-up.
- If you did not change something (e.g., IDL, client), say so briefly so the user can decide to do it manually.
