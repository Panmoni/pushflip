---
title: Contributing
diataxis_type: how-to
last_compiled: 2026-04-11
---

# Contributing

The canonical contributor guide is the repository's [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) at the project root. It covers:

- Toolchain prerequisites (Rust, Solana CLI, Node + pnpm, Python)
- Workspace layout and which package owns what
- Code conventions per language (Rust formatting, TypeScript style, kebab-case filenames in the frontend)
- Test commands per workspace
- Three well-scoped open work tracks anyone can pick up

## Wiki contributions

The wiki itself follows a few conventions:

1. **Every page declares frontmatter** with at minimum `title`, `diataxis_type`, and `last_compiled`. See the [Frontmatter Template](../meta/frontmatter-template.md) for the full schema. The health check script will fail your PR if any required field is missing.
2. **`diataxis_type` follows the [Diátaxis framework](https://diataxis.fr/)** — exactly one of `how-to`, `reference`, `explanation`, or `tutorial`. If you're unsure which fits, default to `explanation` for prose docs and `reference` for tables/specifications.
3. **Update `last_compiled` to today's date** any time you edit a page. This drives the staleness sweep that runs weekly in CI.
4. **Cross-reference between wiki pages** with relative paths (e.g. `../architecture/glossary.md`). Cross-reference into the rest of the repo with paths relative to `docs/wiki/<section>/` — three levels up to reach the repo root.
5. **Code blocks should declare a language** so syntax highlighting kicks in (` ```bash`, ` ```rust`, ` ```typescript`).

## Local preview

```bash
# One-time setup
python3 -m venv wiki/.venv
source wiki/.venv/bin/activate
pip install -r wiki/requirements.txt

# Health check + strict build (CI runs the same)
bash scripts/wiki-health-check.sh --strict
mkdocs build -f wiki/mkdocs.yml --strict

# Live preview
mkdocs serve -f wiki/mkdocs.yml
# → http://127.0.0.1:8000
```
