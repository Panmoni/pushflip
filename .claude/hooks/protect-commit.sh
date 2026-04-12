#!/usr/bin/env bash
# Block `git commit` invocations that would commit changes to a
# protected path (notes.md, lockfiles, secrets, etc.).
#
# Why this hook exists: `git add docs/foo.md && git commit` does NOT
# reset the index — it adds foo.md to whatever is ALREADY staged. If
# the user (or their IDE / git GUI) has staged a protected file via
# the source control panel before Claude runs its commit, that
# protected file gets carried into the commit silently. The pre-edit
# protect-files.sh hook can't catch this because no Edit/Write tool
# call ever ran on the protected file — only the user's IDE
# touched it. Block-dangerous.sh can't catch it either because the
# Bash command (`git commit -m "..."`) doesn't contain the protected
# path as a literal string.
#
# This hook closes that gap by inspecting the staged set BEFORE the
# commit lands. It only fires on `git commit` (not on `git add`,
# `git stash`, `git diff`, etc.) and is keyed to the same protected
# globs that protect-files.sh uses, so the two stay in lockstep.
#
# Lineage: added 2026-04-11 after notes.md was accidentally committed
# in 8dc19b9 — "docs(plan): close Phase 3B". The user's standing
# instruction is that notes.md is absolutely off-limits, so this is
# the kind of bug that should be impossible to repeat by construction.
#
# shellcheck disable=SC2154  # protected_globs comes from protected-paths.sh

set -uo pipefail

cmd=$(jq -r '.tool_input.command // ""')
[ -z "$cmd" ] && exit 0

# Match `git commit` (possibly with flags, env prefixes, leading
# `cd ... &&`, or chained after `git add`). Word-boundary on
# both sides so `git commit-tree` does NOT match.
if ! echo "$cmd" | grep -qE '(^|[^[:alnum:]_-])git[[:space:]]+commit([[:space:]]|$)'; then
  exit 0
fi

# Escape hatch — same convention as block-dangerous.sh.
if echo "$cmd" | grep -qE '#[[:space:]]*ALLOW-DANGEROUS([^A-Za-z0-9_-]|$)'; then
  exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./protected-paths.sh
. "$script_dir/protected-paths.sh"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repo_root" ]; then
  exit 0
fi
cd "$repo_root" || exit 0

# Get the list of files staged for commit. If git is not available
# or returns an error (e.g., not in a git repo, mid-rebase, etc.),
# fail open — this hook is a safety net, not a hard barrier.
staged=$(git diff --cached --name-only 2>/dev/null || true)
if [ -z "$staged" ]; then
  exit 0
fi

# Check each staged path against every protected glob. Match against
# both the bare relative path (what `git diff --cached` returns) and
# the absolute path (so absolute-path globs in protected_globs hit).
violations=()
while IFS= read -r staged_path; do
  [ -z "$staged_path" ] && continue
  abs_path="$repo_root/$staged_path"
  for pat in "${protected_globs[@]}"; do
    # shellcheck disable=SC2254
    case "$staged_path" in
      $pat)
        violations+=("$staged_path (matched '$pat')")
        continue 2
        ;;
    esac
    # shellcheck disable=SC2254
    case "$abs_path" in
      $pat)
        violations+=("$staged_path (matched '$pat' via absolute path)")
        continue 2
        ;;
    esac
  done
done <<<"$staged"

if [ "${#violations[@]}" -gt 0 ]; then
  echo "Blocked: 'git commit' would commit changes to protected paths:" >&2
  for v in "${violations[@]}"; do
    echo "  - $v" >&2
  done
  echo >&2
  echo "These paths are listed in .claude/hooks/protected-paths.sh" >&2
  echo "and must NEVER be committed by Claude. The user (or their IDE)" >&2
  echo "may have staged them via the source control panel. To proceed:" >&2
  echo >&2
  echo "  1. Tell the user which files are unexpectedly staged." >&2
  echo "  2. Run: git restore --staged <each-protected-file>" >&2
  echo "  3. Re-run the commit." >&2
  echo >&2
  echo "If the user has explicitly authorized this commit, add" >&2
  echo "'# ALLOW-DANGEROUS' as a shell comment in the git commit" >&2
  echo "command to bypass this hook." >&2
  exit 2
fi

exit 0
