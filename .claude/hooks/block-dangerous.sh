#!/usr/bin/env bash
# Block destructive / irreversible commands before they execute.
# Tailored to the pushflip repo (Solana program + ZK circuits).
#
# This is a best-effort safety net, NOT a hard security boundary. See
# docs/CLAUDE_HOOKS.md for the (acknowledged) list of bypass classes.
#
# shellcheck disable=SC2154  # write_verb_patterns + protected_path_patterns come from protected-paths.sh
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./protected-paths.sh
. "$script_dir/protected-paths.sh"

cmd=$(jq -r '.tool_input.command // ""')
[ -z "$cmd" ] && exit 0

# Escape hatch: allow commands that contain a literal `# ALLOW-DANGEROUS`
# comment. Used when Claude needs to embed a dangerous-looking string that
# is NOT actually being executed (README sections, heredocs of scripts,
# grep patterns, docs examples) or when the user has explicitly authorized
# a destructive operation. Documented in docs/CLAUDE_HOOKS.md.
#
# The sentinel must be followed by a non-word char or end-of-line so that
# `# ALLOW-DANGEROUS` also matches when followed by `:` ("# ALLOW-DANGEROUS:
# doc example") or other punctuation — but does NOT silently match a
# hypothetical extension like `ALLOW-DANGEROUS_FOO`.
if echo "$cmd" | grep -qE '#[[:space:]]*ALLOW-DANGEROUS([^A-Za-z0-9_-]|$)'; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Stage 1: unconditionally dangerous command patterns.
# Each entry is an ERE pattern matched case-insensitively.
# ---------------------------------------------------------------------------
dangerous_patterns=(
  # rm with a recursive flag — clustered (rm -rf, rm -Rvf, rm -fR, rm -r)
  '(^|[^[:alnum:]])rm[[:space:]]+-[a-zA-Z]*[rR]'
  # rm with a recursive flag — split across flag words (rm -f -r, rm -v -f -r)
  '(^|[^[:alnum:]])rm[[:space:]]+(-[a-zA-Z]+[[:space:]]+){1,4}-[a-zA-Z]*[rR]'
  # Git destructive ops
  'git[[:space:]]+reset[[:space:]]+--hard'
  'git[[:space:]]+clean[[:space:]]+-[a-z]*f'
  'git[[:space:]]+push[[:space:]].*--force'
  'git[[:space:]]+push[[:space:]].*-f([[:space:]]|$)'
  'git[[:space:]]+branch[[:space:]]+-D'
  # Curl/wget pipe-to-shell
  'curl[[:space:]].*\|[[:space:]]*(sh|bash|zsh)'
  'wget[[:space:]].*\|[[:space:]]*(sh|bash|zsh)'
  # Solana — irreversible / keypair-destroying
  'solana[[:space:]]+program[[:space:]]+close'
  'solana-keygen[[:space:]]+new'
  # Wiping ZK build (regenerating trusted setup is painful)
  '(^|[^[:alnum:]])rm[[:space:]]+.*zk-circuits/build'
  'cargo[[:space:]]+clean.*zk-circuits'
  # DB destructive
  'DROP[[:space:]]+TABLE'
  'DROP[[:space:]]+DATABASE'
  'TRUNCATE[[:space:]]+TABLE'
)

for pattern in "${dangerous_patterns[@]}"; do
  if echo "$cmd" | grep -qiE "$pattern"; then
    echo "Blocked: command matches dangerous pattern '$pattern'." >&2
    echo "Command: $cmd" >&2
    echo "If this is intentional, add '# ALLOW-DANGEROUS' as a comment in the command or ask the user to run it manually." >&2
    exit 2
  fi
done

# ---------------------------------------------------------------------------
# Stage 2: writes to protected paths via the Bash tool.
# protect-files.sh only fires on Edit|Write|MultiEdit, so Bash-level writes
# (cp, mv, rm, tee, sed -i, `>` redirect, etc.) are the blind spot this
# closes. A command is blocked only if it contains BOTH a write verb AND
# a protected-path token.
# ---------------------------------------------------------------------------

has_write=false
for wp in "${write_verb_patterns[@]}"; do
  if echo "$cmd" | grep -qE "$wp"; then
    has_write=true
    break
  fi
done

if $has_write; then
  for pp in "${protected_path_patterns[@]}"; do
    if echo "$cmd" | grep -qE "$pp"; then
      echo "Blocked: command appears to write to a protected path." >&2
      echo "Matched pattern: '$pp'" >&2
      echo "Command: $cmd" >&2
      echo "If this is intentional (e.g., the user asked you to rotate a secret or regenerate a lockfile), add '# ALLOW-DANGEROUS' as a comment or ask the user to run it manually." >&2
      exit 2
    fi
  done
fi

exit 0
