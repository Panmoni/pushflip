#!/usr/bin/env bash
# Gate `gh pr create` on a passing test suite.
# Only fires when the Bash command is actually creating a PR.
set -uo pipefail

cmd=$(jq -r '.tool_input.command // ""')

# Match `gh pr create` (possibly with flags, env prefixes, etc.).
if ! echo "$cmd" | grep -qE '(^|[^a-zA-Z])gh[[:space:]]+pr[[:space:]]+create'; then
  exit 0
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
cd "$repo_root" || exit 0

echo "[pre-pr-gate] Running 'cargo test -p pushflip' (max 5 min) before PR creation..." >&2

test_log=$(mktemp -t pre-pr-gate.XXXXXX)
trap 'rm -f "$test_log"' EXIT

timeout 300 cargo test -p pushflip --quiet >"$test_log" 2>&1
rc=$?

if [ "$rc" = 0 ]; then
  exit 0
fi

if [ "$rc" = 124 ]; then
  echo "Blocked: 'cargo test -p pushflip' exceeded the 5-minute pre-PR timeout." >&2
  echo "Run the tests manually to see what's hanging, then retry or ask the user to override." >&2
else
  echo "Blocked: 'cargo test -p pushflip' failed (exit $rc). Last 40 lines of test output:" >&2
  tail -40 "$test_log" >&2
  echo "Fix the failing tests before creating the PR." >&2
fi
exit 2
