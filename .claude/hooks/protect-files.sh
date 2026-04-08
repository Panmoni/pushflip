#!/usr/bin/env bash
# Block edits/writes to off-limits files.
# Exit 2 blocks the tool call and returns the stderr message to Claude.
#
# Protected path list lives in protected-paths.sh so block-dangerous.sh
# (Bash matcher) can enforce the same list on shell-level writes.
#
# shellcheck disable=SC2154  # protected_globs comes from protected-paths.sh
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./protected-paths.sh
. "$script_dir/protected-paths.sh"

file=$(jq -r '.tool_input.file_path // .tool_input.path // ""')
[ -z "$file" ] && exit 0

# Build the set of paths to check: the raw path plus its realpath, so a
# symlink pointing at a protected target is still caught (e.g.
# `ln -s notes.md foo.md` then writing to foo.md).
paths_to_check=("$file")
if command -v readlink >/dev/null 2>&1; then
  resolved=$(readlink -f -- "$file" 2>/dev/null || true)
  if [ -n "$resolved" ] && [ "$resolved" != "$file" ]; then
    paths_to_check+=("$resolved")
  fi
fi

for candidate in "${paths_to_check[@]}"; do
  for pat in "${protected_globs[@]}"; do
    # shellcheck disable=SC2254
    case "$candidate" in
      $pat)
        echo "Blocked: '$file' is protected by .claude/hooks/protect-files.sh (matched '$pat' on path '$candidate')." >&2
        if [ "$candidate" != "$file" ]; then
          echo "Note: path resolved through a symlink to '$candidate'." >&2
        fi
        echo "If the user explicitly asked for this edit, tell them the hook blocked it and ask them to confirm or edit manually." >&2
        exit 2
        ;;
    esac
  done
done

exit 0
