# Claude Code Hooks

This repo uses [Claude Code hooks](https://code.claude.com/docs/en/hooks) as a safety net for AI-assisted development. Hooks are shell scripts that run automatically before or after every tool call — they enforce rules mechanically instead of relying on Claude following CLAUDE.md instructions.

## Why

`CLAUDE.md` is a suggestion — Claude follows it ~80% of the time. Hooks are a **best-effort safety net**: they fire on every tool call, return a non-zero exit code to block an action, and report the reason back to Claude so it can adjust.

For this repo specifically, the blast radius of a mistaken tool call is high: overwriting the deployed program keypair forces a redeploy to a new address, deleting a `.zkey` or `.ptau` file destroys trusted-setup output that is painful to regenerate, and editing [notes.md](../notes.md) is explicitly off-limits. Hooks make those mistakes much harder to make accidentally.

### What hooks are NOT

Hooks are a safety net, **not** a hard security boundary. They use regex and glob matching on tool inputs and can be bypassed by:

- Variable reconstruction (`R=rm; $R -rf ...`), `eval`, or `bash -c '...'`
- Command forms the regex doesn't cover
- Prompt injection that deliberately targets a known gap

Treat hooks as defense in depth: they stop the common mistakes and force Claude to pause on the rest, but do not rely on them as the only thing between Claude and your filesystem. Review [protected-paths.sh](../.claude/hooks/protected-paths.sh) periodically to confirm the list still matches the repo's sensitive files.

## Installed hooks

All hooks live in [.claude/hooks/](../.claude/hooks/) and are wired via [.claude/settings.json](../.claude/settings.json). The two PreToolUse guards (`protect-files.sh` and `block-dangerous.sh`) share a single source of truth for the protected-path list: [.claude/hooks/protected-paths.sh](../.claude/hooks/protected-paths.sh). **Add new protected paths there, in both arrays** (`protected_globs` for the Edit/Write matcher and `protected_path_patterns` for the Bash matcher).

| Hook | Phase | Tool matcher | Purpose |
|---|---|---|---|
| [protect-files.sh](../.claude/hooks/protect-files.sh) | PreToolUse | `Edit\|Write\|MultiEdit` | Blocks edits to protected paths (exit 2). Resolves symlinks before matching. |
| [block-dangerous.sh](../.claude/hooks/block-dangerous.sh) | PreToolUse | `Bash` | Blocks destructive commands AND Bash-level writes to protected paths (exit 2) |
| [log-commands.sh](../.claude/hooks/log-commands.sh) | PreToolUse | `Bash` | Appends every Bash command to `.claude/command-log.txt` (0600, best-effort redacted) |
| [pre-pr-gate.sh](../.claude/hooks/pre-pr-gate.sh) | PreToolUse | `Bash` | Runs `cargo test -p pushflip` with a 5-minute timeout before `gh pr create` |
| [format.sh](../.claude/hooks/format.sh) | PostToolUse | `Edit\|Write\|MultiEdit` | `rustfmt` / `prettier` on the edited file |
| [lint.sh](../.claude/hooks/lint.sh) | PostToolUse | `Edit\|Write\|MultiEdit` | `cargo check` / `eslint` feedback into Claude's context |

### Protected files

`protect-files.sh` and `block-dangerous.sh` both read [.claude/hooks/protected-paths.sh](../.claude/hooks/protected-paths.sh), which blocks writes to:

- [notes.md](../notes.md) — personal notes, explicitly off-limits
- `target/deploy/*-keypair.json`, `program/keypair.json` — program keypairs (overwriting = redeploy to new address)
- `~/.config/solana/id.json` — Solana CLI default wallet
- `*.zkey`, `*_final.zkey`, `*.ptau` — ZK trusted-setup outputs
- `.env`, `.env.*`, `*.pem`, `*.key`, `secrets/*` — credentials
- `pnpm-lock.yaml`, `Cargo.lock`, `package-lock.json`, `yarn.lock` — lockfiles (only on explicit user request)

`protect-files.sh` resolves symlinks before matching via `readlink -f`, so `ln -s notes.md foo.md && edit foo.md` is still blocked. `block-dangerous.sh` closes the Bash-level blind spot with a two-stage match: the command is blocked only if it contains BOTH a write verb (`rm`, `mv`, `cp`, `tee`, `sed -i`, `truncate`, `dd of=`, `>`, `>>`, etc.) AND a protected-path token.

### Blocked commands

`block-dangerous.sh` also blocks unconditionally destructive commands (case-insensitive regex):

- `rm -rf`, `rm -r -f`, `rm -f -r`, and any other recursive `rm` (clustered or split flags)
- `git reset --hard`, `git clean -f`, `git push --force`, `git push -f`, `git branch -D`
- `curl … | sh`, `wget … | bash`
- `solana program close`, `solana-keygen new`
- `rm …zk-circuits/build`, `cargo clean …zk-circuits`
- `DROP TABLE`, `DROP DATABASE`, `TRUNCATE TABLE`

When a hook blocks an action, Claude sees the stderr message and can either propose a safer alternative or ask the user to run the command manually.

### Escape hatch: `# ALLOW-DANGEROUS`

The blocklist is a coarse regex match over the full command string, which means it will also trigger on **literal strings** inside heredocs, scripts, README sections, `grep '...'` patterns, and similar — even when the dangerous command is never actually executed. During this repo's first security review of the hooks, the review script was blocked by its own hook because it contained literal `rm -rf` inside a test fixture.

To bypass the check intentionally, include `# ALLOW-DANGEROUS` as a comment anywhere in the command:

```bash
cat <<'EOF' > /tmp/example.sh  # ALLOW-DANGEROUS: doc example, not executed
rm -rf /tmp/fake_dir
EOF
```

Use this sparingly and only when the command is safe by construction — writing docs, grepping for a literal, testing the hook itself, or a cleanup the user explicitly authorized. The escape hatch exists so Claude can work with files that contain literal dangerous-looking strings; do not use it to run actually-destructive commands without user approval.

## Deliberately not installed

- **Tests on every edit** — full `cargo test` is too slow for the edit loop. `cargo check` runs instead via `lint.sh`; the full test suite is reserved for the pre-PR gate.
- **Auto-commit on Stop** — violates [.claude/rules/git-commits.md](../.claude/rules/git-commits.md) ("do not create commits unless the user specifically asks"). Skipped.

## Local audit log

Every Bash command Claude runs is appended with a timestamp to `.claude/command-log.txt` (gitignored, created with `0600` perms). [log-commands.sh](../.claude/hooks/log-commands.sh) applies **best-effort** redaction to common secret shapes:

- `Authorization: Bearer …` / `Authorization: Basic …`
- `--token=…`, `--token …`, `--password=…`, `--password …`
- `-H "…Auth…: …"` curl-style header args
- Database URLs (`postgres://user:pass@host`, `mysql://user:pass@host`)
- Env-var assignments matching `*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*API_KEY*`, `*PRIVATE_KEY*`, `*ACCESS_KEY*`

Redaction is **not exhaustive** — novel secret formats, unusual CLI tools, or inline credentials in source files will slip through. Assume the log may still contain secrets and purge it periodically if Claude has been running commands with credentials on the command line. If the log grows unwieldy, safe to delete — it regenerates on next use.

## Bypassing a hook

If Claude genuinely needs to edit a protected file (rotating a secret, adding a new lockfile entry, migrating keypairs), the hook will block it and explain why. Options:

1. Ask the user to make the edit manually.
2. Temporarily comment out the relevant entry in [.claude/hooks/protected-paths.sh](../.claude/hooks/protected-paths.sh), make the edit, then restore.
3. For Bash commands only: add `# ALLOW-DANGEROUS` as a comment (see above).

Do **not** bypass `block-dangerous.sh` patterns without strong justification — every entry is there because the action is irreversible.

## Related

- [.claude/rules/git-commits.md](../.claude/rules/git-commits.md) — commit policy (no auto-commit hook by design)
- [.claude/rules/blockchain-patterns.md](../.claude/rules/blockchain-patterns.md) — project coding conventions
- Hook docs: <https://code.claude.com/docs/en/hooks>
