#!/usr/bin/env bash
#
# Wiki health check — validates frontmatter, staleness, and cross-references
# across every page under docs/wiki/.
#
# Exits 0 on green, 1 on warnings, 2 on errors.
# Pass --strict to escalate warnings to errors (CI mode).
#
# Validations:
#   1. Required frontmatter present: title, diataxis_type, last_compiled
#   2. diataxis_type is one of: how-to, reference, explanation, tutorial
#   3. last_compiled parses as YYYY-MM-DD
#   4. Staleness: last_compiled more than STALENESS_DAYS old → warning
#      (or error in --strict mode)
#   5. related_wiki references resolve (every listed path exists)
#
# No Python dependency — bash + coreutils + grep + sed only. Designed to
# run identically locally and in CI.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WIKI_ROOT="$REPO_ROOT/docs/wiki"
STALENESS_DAYS="${STALENESS_DAYS:-60}"
STRICT=0

# Color codes (no-op if NO_COLOR is set)
if [[ -z "${NO_COLOR:-}" && -t 1 ]]; then
  RED=$'\033[0;31m'
  YELLOW=$'\033[0;33m'
  GREEN=$'\033[0;32m'
  DIM=$'\033[2m'
  RESET=$'\033[0m'
else
  RED=''; YELLOW=''; GREEN=''; DIM=''; RESET=''
fi

for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=1 ;;
    -h|--help)
      cat <<EOF
Usage: $0 [--strict]

Validates wiki frontmatter and cross-references across docs/wiki/.

Options:
  --strict   Exit non-zero on warnings (CI mode). Default: warnings are
             reported but don't fail the run.

Environment:
  STALENESS_DAYS   How old (in days) last_compiled must be before staleness
                   warnings fire. Default: 60.
  NO_COLOR         If set, suppress ANSI color codes.

Exit codes:
  0  All checks passed.
  1  Warnings only (or staleness in --strict mode).
  2  Errors.
EOF
      exit 0 ;;
  esac
done

errors=0
warnings=0

today_epoch=$(date +%s)
stale_threshold_seconds=$((STALENESS_DAYS * 86400))

valid_diataxis_types="how-to reference explanation tutorial"

# Files to check: every .md under docs/wiki/, EXCLUDING the meta/ tree
# (contributor reference, off-nav, exempt from frontmatter governance)
mapfile -t md_files < <(find "$WIKI_ROOT" -type f -name '*.md' ! -path "$WIKI_ROOT/meta/*" | sort)

if [[ ${#md_files[@]} -eq 0 ]]; then
  echo "${RED}error:${RESET} no markdown files found under $WIKI_ROOT" >&2
  exit 2
fi

echo "${DIM}Checking ${#md_files[@]} wiki pages...${RESET}"

for f in "${md_files[@]}"; do
  rel="${f#$REPO_ROOT/}"

  # Extract frontmatter block (between the first two --- delimiters)
  if ! head -1 "$f" | grep -qx -- '---'; then
    echo "${RED}error:${RESET} $rel — missing frontmatter (first line is not ---)"
    errors=$((errors + 1))
    continue
  fi

  fm=$(awk '/^---$/{c++; next} c==1{print} c==2{exit}' "$f")

  # Required field: title
  title=$(echo "$fm" | awk -F': ' '/^title:/ {sub(/^title: */,""); print; exit}')
  if [[ -z "$title" ]]; then
    echo "${RED}error:${RESET} $rel — missing required frontmatter field: title"
    errors=$((errors + 1))
  fi

  # Required field: diataxis_type
  dtype=$(echo "$fm" | awk -F': ' '/^diataxis_type:/ {sub(/^diataxis_type: */,""); print; exit}')
  if [[ -z "$dtype" ]]; then
    echo "${RED}error:${RESET} $rel — missing required frontmatter field: diataxis_type"
    errors=$((errors + 1))
  elif ! echo " $valid_diataxis_types " | grep -q " $dtype "; then
    echo "${RED}error:${RESET} $rel — invalid diataxis_type: '$dtype' (must be one of: $valid_diataxis_types)"
    errors=$((errors + 1))
  fi

  # Required field: last_compiled (YYYY-MM-DD)
  last_compiled=$(echo "$fm" | awk -F': ' '/^last_compiled:/ {sub(/^last_compiled: */,""); print; exit}')
  if [[ -z "$last_compiled" ]]; then
    echo "${RED}error:${RESET} $rel — missing required frontmatter field: last_compiled"
    errors=$((errors + 1))
  elif ! [[ "$last_compiled" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    echo "${RED}error:${RESET} $rel — invalid last_compiled format: '$last_compiled' (must be YYYY-MM-DD)"
    errors=$((errors + 1))
  else
    # Staleness check
    if compiled_epoch=$(date -d "$last_compiled" +%s 2>/dev/null); then
      age_seconds=$((today_epoch - compiled_epoch))
      if (( age_seconds > stale_threshold_seconds )); then
        age_days=$((age_seconds / 86400))
        echo "${YELLOW}warning:${RESET} $rel — last_compiled is $age_days days old (threshold: $STALENESS_DAYS)"
        warnings=$((warnings + 1))
      fi
    fi
  fi

  # related_wiki references resolve
  if echo "$fm" | grep -q '^related_wiki:'; then
    # Extract the YAML list items under related_wiki:
    related_paths=$(echo "$fm" | awk '
      /^related_wiki:/ { in_list=1; next }
      in_list && /^[a-zA-Z_]+:/ { in_list=0 }
      in_list && /^  *- *.+/ { sub(/^  *- */,""); print }
    ')
    while IFS= read -r related; do
      [[ -z "$related" ]] && continue
      target="$WIKI_ROOT/$related"
      if [[ ! -f "$target" ]]; then
        echo "${RED}error:${RESET} $rel — related_wiki target does not exist: $related"
        errors=$((errors + 1))
      fi
    done <<< "$related_paths"
  fi
done

echo
if (( errors > 0 )); then
  echo "${RED}✗ $errors error(s), $warnings warning(s)${RESET}"
  exit 2
elif (( warnings > 0 )); then
  echo "${YELLOW}⚠ 0 errors, $warnings warning(s)${RESET}"
  if (( STRICT == 1 )); then
    echo "${RED}strict mode: warnings escalated to failure${RESET}"
    exit 1
  fi
  exit 1
else
  echo "${GREEN}✓ All ${#md_files[@]} wiki pages passed health check${RESET}"
  exit 0
fi
