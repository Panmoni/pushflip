#!/usr/bin/env bash
# scripts/deploy-tucker.sh
#
# One-shot production deploy of pushflip to tucker. Pulls latest main,
# rebuilds both container images with current production env, restarts
# the systemd-quadlet services, smoke-tests the public endpoints.
#
# Usage:
#   bash scripts/deploy-tucker.sh
#
# Prerequisites:
#   - ssh alias `tucker` resolves to the production host
#   - origin/main is what you want deployed (push your changes first)
#   - tucker has /home/george9874/repos/pushflip/faucet/.env.production
#     containing RPC_ENDPOINT + WS_ENDPOINT (Helius URLs); the same
#     two values are read at build time for the frontend bundle so
#     the deployed app and faucet hit the same RPC.
#
# Design choices (Pre-Mainnet 5.0.7 + tucker-deploy plan, see
# docs/DEPLOYMENT_PLAN.md):
#
#   1. **Deploys `main` and ONLY `main`.** Local feature branches are
#      not pushed to production by this script. To deploy a change,
#      merge it to main first.
#
#   2. **Does NOT touch ~/repos/server-config.** The nginx config
#      lives in a separate repo. Pulling it during a pushflip deploy
#      could pick up an unrelated in-flight typo and break yapbay or
#      other tenants on tucker. nginx config changes go through a
#      separate manual flow. Decoupled by design.
#
#   3. **Sources Helius URLs from tucker's .env.production.** Avoids
#      passing secrets via the command line + keeps a single source
#      of truth (the same file the faucet reads at runtime).
#
#   4. **Tags previous images as :prev BEFORE the build.** A failed
#      deploy can be rolled back with one command (printed on
#      success and on failure for convenience).
#
#   5. **Health-checks both services.** Build succeeds + restart
#      succeeds is necessary but not sufficient. We `curl
#      https://play.pushflip.xyz/` + `/api/health` to confirm
#      end-to-end before declaring done.
#
#   6. **Pre-flight disk check.** Builds need ~1 GB intermediate
#      space; tucker has ~49 GB free at deploy 1, which is plenty,
#      but the check gives an actionable error if disk fills up.

set -euo pipefail

# --- Constants ---
REMOTE_HOST=tucker
REMOTE_REPO=/home/george9874/repos/pushflip
PROD_ENV=/home/george9874/repos/pushflip/faucet/.env.production
PUBLIC_ROOT_URL=https://play.pushflip.xyz
PUBLIC_HEALTH_URL=https://play.pushflip.xyz/api/health
SERVICES=(pushflip-vite pushflip-faucet)
DISK_THRESHOLD_PCT=85
HEALTH_TIMEOUT_S=30

# --- Helpers ---
c_red=$'\e[31m'; c_green=$'\e[32m'; c_yellow=$'\e[33m'; c_dim=$'\e[2m'; c_reset=$'\e[0m'
step() { printf '%s%s%s\n' "$c_dim" "[deploy] $*" "$c_reset"; }
ok()   { printf '%s✓%s %s\n' "$c_green" "$c_reset" "$*"; }
fail() { printf '%s✗%s %s\n' "$c_red" "$c_reset" "$*" >&2; }
note() { printf '%s%s%s\n' "$c_yellow" "$*" "$c_reset"; }

print_rollback_cmd() {
  cat <<EOF

To rollback to the previous build:

  ssh $REMOTE_HOST 'for s in ${SERVICES[*]}; do podman tag localhost/\$s:prev localhost/\$s:latest; done && systemctl --user restart ${SERVICES[*]/%/.service}'

EOF
}

# --- Pre-flight ---
step "ssh + disk pre-flight"
disk_used_pct=$(ssh "$REMOTE_HOST" "df / | tail -1 | awk '{print int(\$5)}'")
if [ "$disk_used_pct" -gt $DISK_THRESHOLD_PCT ]; then
  fail "tucker disk > ${DISK_THRESHOLD_PCT}% full (${disk_used_pct}%); free space first"
  exit 1
fi
ok "disk: ${disk_used_pct}% used (threshold ${DISK_THRESHOLD_PCT}%)"

step "verifying production env file is in place"
ssh "$REMOTE_HOST" "test -f $PROD_ENV && grep -q '^RPC_ENDPOINT=' $PROD_ENV && grep -q '^WS_ENDPOINT=' $PROD_ENV" \
  || { fail "$PROD_ENV missing or RPC_ENDPOINT / WS_ENDPOINT not set"; exit 1; }
ok "$PROD_ENV present + has RPC/WS endpoints"

# --- Tag current images as :prev for rollback (idempotent — first deploy has nothing to tag) ---
step "tagging current images as :prev for rollback"
for img in "${SERVICES[@]}"; do
  ssh "$REMOTE_HOST" "podman image exists localhost/$img:latest && podman tag localhost/$img:latest localhost/$img:prev || echo '  (no prior $img — first deploy)'"
done

# --- Pull latest main ---
step "pulling origin/main + workspace install"
ssh "$REMOTE_HOST" "cd $REMOTE_REPO && git fetch origin main && git checkout main && git reset --hard origin/main && pnpm install --frozen-lockfile" \
  || { fail "git pull / pnpm install failed"; exit 1; }
ok "main checked out + workspace installed"

# --- Rebuild images ---
step "rebuilding pushflip-vite (~2-15 min depending on lockfile churn)"
ssh "$REMOTE_HOST" "set -a; source $PROD_ENV; set +a; cd $REMOTE_REPO && podman build \
  -t localhost/pushflip-vite:latest \
  --build-arg VITE_FAUCET_URL=/api/faucet \
  --build-arg VITE_RPC_ENDPOINT=\"\$RPC_ENDPOINT\" \
  --build-arg VITE_RPC_WS_ENDPOINT=\"\$WS_ENDPOINT\" \
  -f app/Dockerfile ." \
  || { fail "pushflip-vite build failed"; print_rollback_cmd; exit 1; }
ok "pushflip-vite:latest built"

step "rebuilding pushflip-faucet (~1-3 min)"
ssh "$REMOTE_HOST" "cd $REMOTE_REPO && podman build -t localhost/pushflip-faucet:latest -f faucet/Dockerfile ." \
  || { fail "pushflip-faucet build failed"; print_rollback_cmd; exit 1; }
ok "pushflip-faucet:latest built"

# --- Restart services ---
step "systemctl daemon-reload + restart"
ssh "$REMOTE_HOST" "systemctl --user daemon-reload && systemctl --user restart ${SERVICES[*]/%/.service}" \
  || { fail "systemctl restart failed"; print_rollback_cmd; exit 1; }

step "waiting for services to come up (max ${HEALTH_TIMEOUT_S}s each)"
for svc in "${SERVICES[@]}"; do
  if ! ssh "$REMOTE_HOST" "timeout $HEALTH_TIMEOUT_S bash -c 'until systemctl --user is-active --quiet $svc; do sleep 1; done'"; then
    fail "$svc did not reach active state in ${HEALTH_TIMEOUT_S}s"
    ssh "$REMOTE_HOST" "journalctl --user -u $svc.service -n 30 --no-pager" | tail -30
    print_rollback_cmd
    exit 1
  fi
  ok "$svc active"
done

# --- End-to-end smoke ---
step "public-URL smoke check"
http_code=$(curl -sS -o /dev/null -w '%{http_code}' "$PUBLIC_ROOT_URL/" || echo 000)
if [ "$http_code" != "200" ]; then
  fail "$PUBLIC_ROOT_URL/ returned HTTP $http_code (expected 200)"
  print_rollback_cmd
  exit 1
fi
ok "frontend $PUBLIC_ROOT_URL/ -> 200"

http_code=$(curl -sS -o /dev/null -w '%{http_code}' "$PUBLIC_HEALTH_URL" || echo 000)
if [ "$http_code" != "200" ]; then
  fail "$PUBLIC_HEALTH_URL returned HTTP $http_code (expected 200)"
  print_rollback_cmd
  exit 1
fi
ok "faucet $PUBLIC_HEALTH_URL -> 200"

# --- Done ---
echo
ok "deploy complete — live at $PUBLIC_ROOT_URL/"
note "rollback command (in case of post-deploy regression):"
print_rollback_cmd
