#!/usr/bin/env bash
# Append every Bash command Claude runs to a local audit log with
# best-effort secret redaction and restrictive file permissions.
#
# IMPORTANT: redaction is NOT exhaustive. Assume the log may still contain
# secrets; see docs/CLAUDE_HOOKS.md for guidance.
set -euo pipefail

cmd=$(jq -r '.tool_input.command // ""')
[ -z "$cmd" ] && exit 0

log_dir="$(git rev-parse --show-toplevel 2>/dev/null || echo .)/.claude"
log_file="$log_dir/command-log.txt"
mkdir -p "$log_dir"

# Create the log file with 0600 perms on first use so subsequent appends
# inherit the restrictive mode. Not a hard security control (a compromised
# account with shell access can still read it), just reduces the blast
# radius of an accidental `cat .claude/command-log.txt` in a shared terminal.
if [ ! -e "$log_file" ]; then
  ( umask 077 && : >"$log_file" )
fi

# Best-effort redaction of common secret shapes. Fails open: if sed errors
# for any reason (unsupported flag, locale issue, etc.), we log the raw
# command rather than dropping the log entry entirely.
redacted=$(printf '%s' "$cmd" | sed -E \
  -e 's/([Aa]uthorization:[[:space:]]*[Bb]earer[[:space:]]+)[^[:space:]]+/\1<REDACTED>/g' \
  -e 's/([Aa]uthorization:[[:space:]]*[Bb]asic[[:space:]]+)[^[:space:]]+/\1<REDACTED>/g' \
  -e 's/(--token[= ])[^[:space:]]+/\1<REDACTED>/g' \
  -e 's/(--password[= ])[^[:space:]]+/\1<REDACTED>/g' \
  -e 's#(postgres(ql)?://[^:/[:space:]]+:)[^@[:space:]]+#\1<REDACTED>#g' \
  -e 's#(mysql://[^:/[:space:]]+:)[^@[:space:]]+#\1<REDACTED>#g' \
  -e 's/([A-Za-z_][A-Za-z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)[A-Za-z0-9_]*=)[^[:space:]]+/\1<REDACTED>/g' \
  2>/dev/null) || redacted="$cmd"

printf '%s\t%s\n' "$(date -Is)" "$redacted" >> "$log_file"
exit 0
