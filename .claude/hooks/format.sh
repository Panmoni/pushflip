#!/usr/bin/env bash
# Auto-format the file Claude just wrote/edited, picking the right tool by extension.
# Always exits 0 — formatting failures shouldn't block Claude, just inform.
set -uo pipefail

file=$(jq -r '.tool_input.file_path // ""')
[ -z "$file" ] && exit 0
[ ! -f "$file" ] && exit 0

# Skip generated / vendored paths.
case "$file" in
  */target/*|*/node_modules/*|*/zk-circuits/build/*|*/clients/js/generated/*)
    exit 0
    ;;
esac

case "$file" in
  *.rs)
    rustfmt --edition 2021 "$file" 2>&1 | tail -5 || true
    ;;
  *.ts|*.tsx|*.js|*.jsx|*.json|*.md|*.yml|*.yaml)
    # Use local prettier if available, otherwise skip silently.
    if command -v pnpm >/dev/null 2>&1 && pnpm exec prettier --version >/dev/null 2>&1; then
      pnpm exec prettier --write --log-level warn "$file" 2>&1 | tail -5 || true
    fi
    ;;
esac

exit 0
