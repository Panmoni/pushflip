#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034
#
# Single source of truth for protected paths.
# SOURCED by:
#   - protect-files.sh  (PreToolUse on Edit|Write|MultiEdit)
#   - block-dangerous.sh (PreToolUse on Bash)
#
# Do not add side effects. This file is sourced, not executed.
#
# If you add a new protected path, add it to BOTH arrays below:
#   - protected_globs         — shell glob, used by protect-files.sh (case match)
#   - protected_path_patterns — ERE regex, used by block-dangerous.sh (grep match)

# ---------------------------------------------------------------------------
# Glob patterns matched with `case` against tool_input.file_path.
# Both absolute and relative forms are listed because `*/foo` does not match
# a bare `foo`. Claude Code Edit/Write currently requires absolute paths, but
# listing the relative forms is cheap insurance against future changes.
# ---------------------------------------------------------------------------
protected_globs=(
  # User's personal notes — see .claude/rules and auto-memory: never edit.
  "*/pushflip/notes.md"
  "*/pushflip/notes"
  "notes.md"
  "./notes.md"
  "notes"
  "./notes"
  # Solana program keypairs: losing or overwriting these changes the deployed
  # program ID and forces a redeploy to a new address.
  "*/target/deploy/*-keypair.json"
  "target/deploy/*-keypair.json"
  "*/program/keypair.json"
  "program/keypair.json"
  # Solana CLI default wallet (more specific than the old "*/id.json").
  "*/.config/solana/id.json"
  "*/.config/solana/*.json"
  # ZK trusted-setup outputs — expensive and slow to regenerate.
  "*.zkey"
  "*.ptau"
  "*_final.zkey"
  # Secrets and credentials.
  "*/.env"
  "*/.env.*"
  ".env"
  ".env.*"
  "*.pem"
  "*.key"
  "*/secrets/*"
  "secrets/*"
  # Lockfiles — only touch on explicit user request.
  "*/pnpm-lock.yaml"
  "pnpm-lock.yaml"
  "*/Cargo.lock"
  "Cargo.lock"
  "*/package-lock.json"
  "package-lock.json"
  "*/yarn.lock"
  "yarn.lock"
)

# ---------------------------------------------------------------------------
# ERE regex fragments matched (case-sensitively) against the full Bash command
# string. Each pattern is "word-bounded" using explicit character classes
# because ERE does not portably support \b.
#
# Used together with `write_verb_patterns` below: block if BOTH a write verb
# AND a protected-path token appear in the command.
# ---------------------------------------------------------------------------
#
# Token boundary classes (asymmetric on purpose):
#   - PRECEDING: [^[:alnum:]_.-]  — allows `/` so `/abs/path/notes.md` matches
#   - FOLLOWING: [^[:alnum:]/_.-] — disallows `/` so `notes.md/child` does NOT match
# ERE does not portably support \b, hence the explicit character classes.
protected_path_patterns=(
  # notes.md / notes — token match (not a substring of 'my_notes.md')
  '(^|[^[:alnum:]_.-])notes\.md([[:space:]]|$|[^[:alnum:]/_.-])'
  '(^|[^[:alnum:]_.-])notes([[:space:]]|$)'
  # ZK trusted-setup outputs
  '\.zkey([[:space:]]|$|[^[:alnum:]/_.-])'
  '\.ptau([[:space:]]|$|[^[:alnum:]/_.-])'
  # Solana program keypairs
  'target/deploy/[^[:space:]]*keypair\.json'
  'program/keypair\.json'
  # Solana CLI default wallet — only the canonical location, not any id.json
  '/\.config/solana/id\.json'
  '/\.config/solana/[^[:space:]/]+\.json'
  # Secrets and credentials
  '(^|[^[:alnum:]_.-])\.env([[:space:]/]|$|\.[[:alpha:]])'
  '\.pem([[:space:]]|$|[^[:alnum:]/_.-])'
  '\.key([[:space:]]|$|[^[:alnum:]/_.-])'
  '(^|[^[:alnum:]_.-])secrets/'
  # Lockfiles
  '(^|[^[:alnum:]_.-])pnpm-lock\.yaml([[:space:]]|$|[^[:alnum:]/_.-])'
  '(^|[^[:alnum:]_.-])Cargo\.lock([[:space:]]|$|[^[:alnum:]/_.-])'
  '(^|[^[:alnum:]_.-])package-lock\.json([[:space:]]|$|[^[:alnum:]/_.-])'
  '(^|[^[:alnum:]_.-])yarn\.lock([[:space:]]|$|[^[:alnum:]/_.-])'
)

# ---------------------------------------------------------------------------
# ERE regex fragments for shell commands that WRITE to a file/path.
# Combined with protected_path_patterns: a command is blocked only if it
# matches at least one of these AND one protected-path pattern.
# ---------------------------------------------------------------------------
write_verb_patterns=(
  '(^|[^[:alnum:]])rm[[:space:]]'
  '(^|[^[:alnum:]])mv[[:space:]]'
  '(^|[^[:alnum:]])cp[[:space:]]'
  '(^|[^[:alnum:]])tee([[:space:]]|$)'
  '(^|[^[:alnum:]])truncate[[:space:]]'
  '(^|[^[:alnum:]])shred[[:space:]]'
  '(^|[^[:alnum:]])sed[[:space:]]+-i'
  '(^|[^[:alnum:]])dd[[:space:]].*of='
  # Redirection: `> file` or `>> file` (but not `>&2`, `>/dev/null` via pipe, etc.)
  '>[[:space:]]*[^|&[:space:]]'
  '>>[[:space:]]*[^[:space:]]'
)
