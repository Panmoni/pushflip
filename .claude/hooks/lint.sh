#!/usr/bin/env bash
# Lint feedback after an edit. Runs clippy for Rust or eslint for TS.
# Always exits 0 — lint output is advisory, it feeds back into Claude's context.
set -uo pipefail

file=$(jq -r '.tool_input.file_path // ""')
[ -z "$file" ] && exit 0

case "$file" in
  */target/*|*/node_modules/*|*/zk-circuits/build/*|*/clients/js/generated/*)
    exit 0
    ;;
esac

case "$file" in
  *.rs)
    # Fast check, not full clippy-all, to keep the edit loop snappy.
    (cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
      cargo check --message-format=short 2>&1 | tail -20) || true
    ;;
  *.ts|*.tsx)
    if command -v pnpm >/dev/null 2>&1 && pnpm exec eslint --version >/dev/null 2>&1; then
      pnpm exec eslint "$file" 2>&1 | tail -20 || true
    fi
    ;;
esac

exit 0
