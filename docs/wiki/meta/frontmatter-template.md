---
title: Frontmatter Template
diataxis_type: reference
last_compiled: 2026-04-11
---

# Frontmatter Template

Every page in this wiki (except files under `meta/`) must declare a YAML
frontmatter block at the very top of the file. The health check script at
[`scripts/wiki-health-check.sh`](../../../scripts/wiki-health-check.sh)
will fail your build if any required field is missing or malformed.

## Required fields

| Field | Type | Description |
|---|---|---|
| `title` | string | Display title shown in the page header and nav. Should match the page's H1. |
| `diataxis_type` | enum | One of `how-to`, `reference`, `explanation`, or `tutorial`. See the [Diátaxis framework](https://diataxis.fr/) for guidance on which to choose. |
| `last_compiled` | YYYY-MM-DD | The last date the content was reviewed for accuracy. **Update this every time you edit the page.** Pages older than 60 days emit a staleness warning in the weekly CI sweep. |

## Optional fields

| Field | Type | Description |
|---|---|---|
| `sources` | list of strings | Authoritative source files for the content on this page (e.g., `program/src/state/game_session.rs`). Helpful for traceability. |
| `code_refs` | list of strings | Related code call-sites that aren't authoritative but are useful pointers. |
| `related_wiki` | list of strings | Other wiki page paths (relative to `docs/wiki/`) that this page is related to. **Health check verifies these resolve.** |
| `tags` | list of strings | Free-form tags for grouping (no schema, no validation). |
| `status` | string | Optional status marker like `draft`, `stable`, `deprecated`. |

## Diátaxis quick guide

Choose `diataxis_type` based on what the page does for the reader:

- **`tutorial`** — Teaches a beginner by walking them through a concrete example end to end. Goal: skill acquisition. ("Build your first card game in 30 minutes.")
- **`how-to`** — Solves a specific problem the reader already understands. Goal: task completion. ("How to deploy a new program version to devnet.")
- **`reference`** — Describes how something works in technical detail. Goal: lookup. ("GameSession byte layout.")
- **`explanation`** — Discusses, contextualizes, or explains the *why*. Goal: understanding. ("Why we chose Pinocchio over Anchor.")

If you can't decide, default to `explanation` for prose docs and `reference` for tables/specifications. You can change it later — the health check only validates the value is one of the four.

## Example

Copy-paste this template into the top of your new page:

```yaml
---
title: GameSession Byte Layout
diataxis_type: reference
last_compiled: 2026-04-11
sources:
  - program/src/state/game_session.rs
code_refs:
  - clients/js/src/accounts/game-session.ts
related_wiki:
  - architecture/glossary.md
tags:
  - on-chain
  - serialization
---

# GameSession Byte Layout

Page content starts here...
```

## Why frontmatter governance matters

The reference pattern this wiki ports comes from a project that learned the
hard way that markdown rules without an enforcement mechanism drift within
weeks. The health check script + CI workflow are the *mechanism*; this
template is just the contract.

See the project memory `feedback_workflow_to_mechanism.md` for the
underlying principle: every workflow rule should be backed by a build-time
or CI-time check, not just documentation.
