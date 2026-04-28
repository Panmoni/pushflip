---
title: Dealer Runbook
diataxis_type: how-to
last_compiled: 2026-04-28
related_wiki:
  - operations/hosting-and-rpc.md
  - operations/podman-rootless-network-traps.md
  - architecture/index.md
  - architecture/threat-model.md
---

# Dealer Runbook

Operational guide for running the PushFlip ZK dealer ([dealer/](https://github.com/Panmoni/pushflip/blob/main/dealer)) in production. Today the dealer runs as part of the smoke-test pipeline + as a service skeleton ([`dealer/src/service.ts`](https://github.com/Panmoni/pushflip/blob/main/dealer/src/service.ts), code-complete pre-deploy 2026-04-28). This page is the runbook for the first 24/7 deployment.

**Scope.** Phase 3 (devnet active demos) and Phase 4 (House AI depends on a live dealer). Mainnet-scale operations are out of scope until [Pre-Mainnet 5.0.2](https://github.com/Panmoni/pushflip/blob/main/docs/EXECUTION_PLAN.md) (threshold randomness) replaces the single-trusted-dealer model.

For VPS sizing + RPC plan selection, see [Hosting & RPC](hosting-and-rpc.md). For the trust assumptions behind the dealer, see [Threat Model → Dealer role](../architecture/threat-model.md#trust-assumptions-per-role).

## What the dealer does

A TypeScript service that owns the random shuffle + ZK proof for every round:

1. **Shuffle.** Fisher-Yates over the 94-card canonical deck using `crypto.getRandomValues()`.
2. **Commit.** Build a Poseidon Merkle tree over the shuffled deck; serialize the root.
3. **Prove.** Generate a Groth16 proof (via `snarkjs` + the compiled `shuffle_verify.circom` circuit) that the shuffled deck is a valid permutation of the canonical deck.
4. **Submit.** Sign + send `commit_deck` with the proof + root + canonical hash as instruction data. Only the game's dealer keypair can sign this instruction.
5. **Reveal.** As players call `hit`, serve each card with its 7-depth Merkle proof so the on-chain `sol_poseidon`-backed Merkle verifier can confirm the card was in the committed deck.

Source lives at [`dealer/src/dealer.ts`](https://github.com/Panmoni/pushflip/blob/main/dealer/src/dealer.ts) (the library) and [`dealer/src/service.ts`](https://github.com/Panmoni/pushflip/blob/main/dealer/src/service.ts) (the HTTP daemon wrapping it). The library is consumed in-source via `tsx`; the service runs in its own podman container per the deploy described below.

## Pre-Mainnet 5.2 deploy plan (target: tucker, share infra with faucet)

This is the concrete plan for the first dealer production deploy. It sits on top of the existing tucker infrastructure ([Pre-Mainnet 5.0.7 deploy](https://github.com/Panmoni/pushflip/blob/main/docs/DEPLOYMENT_PLAN.md)) — same VPS, same nginx, same podman+systemd-quadlet pattern, same `pushflip` pod. The dealer becomes a third container in the pod alongside `pushflip-vite` and `pushflip-faucet`.

Status as of 2026-04-28: **service skeleton + Dockerfile + this runbook are committed; actual deploy is gated on the open decisions in the next subsection.**

### Decisions locked in 2026-04-28 (Pre-Mainnet 5.2)

1. **Dealer keypair source = Option C: new game with dedicated dealer keypair.** The current `game_id=2` dealer is `wallet.address` from the user's CLI wallet `~/.config/solana/id.json`. Shipping that to tucker would expand blast radius beyond pushflip-devnet. The on-chain program has no `rotate-dealer` instruction (only the `set_dealer` setter on `GameSession` exists, but it's not exposed via any instruction), so rotation requires a fresh `init_game` with the new dealer pubkey. Cost: `GAME_ID` constant in [`app/src/lib/constants.ts`](https://github.com/Panmoni/pushflip/blob/main/app/src/lib/constants.ts) changes (likely `2n` → `3n`). [`scripts/init-game.ts`](https://github.com/Panmoni/pushflip/blob/main/scripts/init-game.ts) updated to accept `DEALER_PUBKEY` env var (defaulting to wallet.address for legacy behavior).

2. **Round commit trigger = polling auto-commit, no manual override exposed.** [`dealer/src/service.ts`](https://github.com/Panmoni/pushflip/blob/main/dealer/src/service.ts)'s `startAutoCommitLoop` polls the GameSession every `POLL_INTERVAL_MS=5000` ms. When `!round_active && !deck_committed && active_player_count >= MIN_PLAYERS_TO_COMMIT (=2) && committedRoundNumber !== current round_number`, the loop calls `commitDeckForGame`. The `commitInFlight` mutex is claimed BEFORE the first await so two ticks can't race past it; same single-threaded-Node-event-loop reasoning as the faucet's `pendingClaims` Set, applied at the right point in the function body. The `POST /commit/:gameId` operator-override endpoint was deliberately NOT exposed (heavy-duty review finding H3 — public, unauthenticated, no player-count guard); if needed later, add it back behind a shared-secret header (`X-Dealer-Operator: ...`) plus the same player-count check the auto-loop has.

3. **`commit_deck` submission code path = extracted to [`dealer/src/commit-tx.ts`](https://github.com/Panmoni/pushflip/blob/main/dealer/src/commit-tx.ts).** New `commitDeckForGame()` helper takes `{dealer, dealerSigner, rpc, sendAndConfirm, gameId}` and runs: shuffle → build `commit_deck` ix with `COMMIT_DECK_COMPUTE_LIMIT=400_000` CU bump → blockhash → sign → confirm → return `{signature, gameSession}`. The auto-commit poll loop is the single caller. `scripts/smoke-test.ts` keeps its inline copy for now (separate cleanup task — folding the smoke-test into the helper would require a small smoke-test refactor that's not load-bearing for the dealer deploy).

4. **Frontend `hit()` integration = wired in [`app/src/hooks/use-game-actions.ts`](https://github.com/Panmoni/pushflip/blob/main/app/src/hooks/use-game-actions.ts).** New `resolveDealerUrl()` (same shape + production guard as `resolveFaucetUrl` / `resolveNicknameBaseUrl`) + `fetchDealerReveal(gameId, roundNumber, leafIndex)` helper. The hit mutation now: reads on-chain `GameSession.roundNumber + drawCounter` → fetches `/api/dealer/reveal/<gameId>/<roundNumber>/<drawCounter>` → builds `getHitInstruction` with the returned card + proof → wallet-signs + submits. New env var `VITE_DEALER_URL` (build-time, set to `/api/dealer` in production by the deploy script).

5. **nginx route = `/api/dealer/*` → `127.0.0.1:3002`.** Same-origin path keeps CORS surface zero. Diff against the live `play.pushflip.xyz.conf` (in the `server-config` repo on tucker, NOT in this repo): add a new `location /api/dealer/` block BEFORE the existing `/api/` block (longest-prefix-match makes the dealer block win) + a separate rate-limit zone (`dealer_req`, 20r/s with burst 30 — generous because `/reveal` is hit per-action during a live round, where the faucet's 5r/s would bite a fast player). Full diff inlined below in the [nginx diff](#nginx-diff) section.

### Deploy artifacts (committed alongside this runbook)

- [`dealer/src/service.ts`](https://github.com/Panmoni/pushflip/blob/main/dealer/src/service.ts) — Hono daemon. Loads env config, opens RPC + WS, holds a single `Dealer` instance. Binds explicitly to `127.0.0.1:3002` so nginx is the only ingress (M1 fix — `Network=host` would otherwise expose the dealer on tucker's public IP, bypassing rate limiting). Endpoints: `GET /health`, `GET /round/:gameId`, `GET /reveal/:gameId/:roundNumber/:leafIndex`. Single-game v1 — multi-game support is a later increment.
- [`dealer/Dockerfile`](https://github.com/Podman/pushflip/blob/main/dealer/Dockerfile) — same install discipline as `faucet/Dockerfile` after Lessons #54-#56: `node:20-slim`, `npm install` with retry loop + cache mount, `--ignore-scripts`, workspace-protocol rewrite at build time. ZK artifacts (~10 MB total: wasm + zkey + vkey) baked into `/app/zk-artifacts/` rather than bind-mounted — they're part of the circuit version and don't change without a redeploy anyway.
- [`dealer/package.json`](https://github.com/Panmoni/pushflip/blob/main/dealer/package.json) — adds `@hono/node-server`, `@solana/kit`, `hono` as runtime deps. Adds `service` and `typecheck` npm scripts.

### Deploy steps (when the open decisions above are resolved)

```bash
# 1. Decide the dealer keypair (decision #1) and place it on tucker:
#    scp ~/.config/solana/pushflip-dealer.json tucker:~/.config/solana/pushflip-dealer.json
#    ssh tucker 'chmod 600 ~/.config/solana/pushflip-dealer.json'
#    Verify identity: ssh tucker 'solana-keygen pubkey ~/.config/solana/pushflip-dealer.json'
#    Should match the on-chain `dealer` field of GameSession at game_id=2.

# 2. Create /home/george9874/repos/pushflip/dealer/.env.production on
#    tucker (mode 0600, NEVER in git):
#       PORT=3002
#       ALLOWED_ORIGINS=https://play.pushflip.xyz
#       RPC_ENDPOINT=https://devnet.helius-rpc.com/?api-key=<HELIUS_KEY>
#       WS_ENDPOINT=wss://devnet.helius-rpc.com/?api-key=<HELIUS_KEY>
#       DEALER_KEYPAIR_PATH=/home/george9874/.config/solana/pushflip-dealer.json
#       ZK_ARTIFACTS_DIR=/app/zk-artifacts
#       GAME_ID=2

# 3. Add the quadlet at ~/.config/containers/systemd/pushflip-dealer.container
#    on tucker (template below).

# 4. Add the dealer to the deploy script:
#    Edit scripts/deploy-tucker.sh:
#      - SERVICES=(pushflip-pod pushflip-vite pushflip-faucet pushflip-dealer)
#      - CONTAINER_IMAGES=(pushflip-vite pushflip-faucet pushflip-dealer)
#      - Add a third `podman build --network=host` step for the dealer
#        (mirroring the existing pushflip-faucet step).

# 5. Add the nginx /api/dealer/* proxy block to server-config + reload nginx.
#    Concrete diff against the live play.pushflip.xyz.conf is in the
#    "nginx diff" section below.

# 6. ./scripts/deploy-tucker.sh
```

### nginx diff

The dealer needs a same-origin path under `play.pushflip.xyz` so the SPA can `fetch('/api/dealer/...')` without CORS. nginx's `location` matching is longest-prefix-wins, so the new `/api/dealer/` block must appear in the same `server {}` as the existing `/api/` (faucet) block — order in the file does not matter, length of the prefix does. A separate rate-limit zone (`dealer_req`) avoids the faucet's 5r/s shared bucket eating a fast player's `/reveal` calls during a live round.

Apply this diff to `~/repos/server-config/nginx/conf.d/play.pushflip.xyz.conf` on tucker (separate `server-config` repo — do NOT commit to pushflip):

```diff
@@ inside the `server { listen 443 ssl; ... }` block @@
     include /etc/nginx/snippets/cloudflare-real-ip.conf;
     include /etc/nginx/snippets/security-headers.conf;

+    # Dealer service (Pre-Mainnet 5.2). MUST appear before the /api/
+    # block conceptually — but nginx uses longest-prefix-match, so this
+    # /api/dealer/ block wins over /api/ regardless of file order.
+    # Strip the /api/dealer prefix; upstream sees /round/:gameId etc.
+    location /api/dealer/ {
+        proxy_pass http://127.0.0.1:3002/;
+        proxy_http_version 1.1;
+        proxy_set_header Host $host;
+        proxy_set_header X-Real-IP $remote_addr;
+        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
+        proxy_set_header X-Forwarded-Proto $scheme;
+        proxy_connect_timeout 30s;
+        proxy_send_timeout 60s;
+        proxy_read_timeout 60s;
+        # 20r/s burst 30 — generous because /reveal is hit per-action
+        # during a live round; the faucet's 5r/s would bite a fast
+        # player. Keyed on $http_cf_connecting_ip so Cloudflare's
+        # orange cloud doesn't collapse this to a single bucket.
+        limit_req zone=dealer_req burst=30 nodelay;
+    }
+
     location /api/ {
         proxy_pass http://127.0.0.1:3001/;
         proxy_http_version 1.1;
@@ end of file @@
 limit_req_zone $http_cf_connecting_ip zone=faucet_req:10m rate=5r/s;
+limit_req_zone $http_cf_connecting_ip zone=dealer_req:10m rate=20r/s;
```

Reload procedure (matches the 5.0.7 deploy pattern):

```bash
ssh tucker
cd ~/repos/server-config
# edit nginx/conf.d/play.pushflip.xyz.conf, apply the diff above
sudo podman exec nginx nginx -t          # MUST pass before reload
sudo podman exec nginx nginx -s reload
curl -I https://play.pushflip.xyz/api/dealer/health   # 200 once the dealer container is up
```

### Quadlet template

`~/.config/containers/systemd/pushflip-dealer.container`:

```ini
[Unit]
Description=PushFlip ZK Dealer Service
After=network-online.target pushflip-pod.service
Wants=network-online.target pushflip-pod.service

[Container]
Image=localhost/pushflip-dealer:latest
ContainerName=pushflip-dealer
Pod=pushflip.pod
WorkingDir=/app/dealer

EnvironmentFile=/home/george9874/repos/pushflip/dealer/.env.production

# Dealer keypair — bind-mounted read-only.
Volume=/home/george9874/.config/solana/pushflip-dealer.json:/home/george9874/.config/solana/pushflip-dealer.json:ro

HealthCmd=wget -q --spider http://localhost:3002/health || exit 1
HealthInterval=30s
HealthTimeout=5s
HealthRetries=3
HealthStartPeriod=15s

# 1 GB ceiling: snarkjs proof generation peaks ~600 MB during the
# witness + Groth16 prover. 1 GB gives 65% headroom.
PodmanArgs=--memory 1g --memory-reservation 512m

LogDriver=journald

[Service]
Restart=always
RestartSec=10s
TimeoutStartSec=120
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

### Risks specific to this deploy

- **Crash mid-round**: in-memory deck + Merkle tree are lost; players who haven't hit yet cannot proceed. Documented in [`service.ts` header](https://github.com/Panmoni/pushflip/blob/main/dealer/src/service.ts). Acceptable for the demo. Mainnet would need persistence of the encrypted shuffled deck or a different protocol.
- **Single dealer instance, single game**: multi-game support is a later increment. For the demo with `game_id=2` only, single-instance is sufficient.
- **`commit_deck` CU budget**: ~86K CU empirically, with the 200K headroom budget set in the smoke-test. The on-chain Groth16 verification dominates. Captured under Pre-Mainnet 5.0.4's `assertCuBudget(rpc, sig, "commit_deck", 200_000)` in smoke-test; the service should adopt the same compute-unit limit (`COMMIT_DECK_COMPUTE_LIMIT` constant).
- **snarkjs proof time**: ~30s on the devnet smoke-test setup. tucker's hardware should be similar; verify on first commit. If it's >60s, the dealer's commit endpoint should return `202 Accepted` and process asynchronously rather than block the HTTP response.

## Deployment topology (when it lands)

The current plan (see [EXECUTION_PLAN.md Phase 5](https://github.com/Panmoni/pushflip/blob/main/docs/EXECUTION_PLAN.md#phase-5-deployment)):

- **One OVH VPS.** Defaults to VPS-1 at $6.46/mo (4 vCPU / 8 GB RAM / 75 GB SSD) — sized for 2 concurrent games. See [Hosting & RPC](hosting-and-rpc.md) for the rationale.
- **One Podman/Docker stack.** `docker-compose.yml` runs: nginx (frontend + reverse proxy), the dealer service, the House AI service(s) — one per active game. All behind a single Helius RPC endpoint.
- **One Helius tier**, Developer ($49/mo) for active devnet demos. Free tier ($0) is the fallback if demos are on-demand only.
- **Solana state is off-box.** The dealer writes to the validator network; nothing stateful lives on the VPS beyond the dealer's keypair + the `snarkjs` proving-key artifacts.

Hetzner is explicitly avoided: they've flagged crypto-adjacent workloads and [`feedback_hosting_provider.md`](https://github.com/Panmoni/pushflip/blob/main/.claude/projects/-home-george9874-repos-pushflip/memory/feedback_hosting_provider.md) in the auto-memory warns to default to OVH for this repo.

## Environment setup

### Required files on the VPS

```
/opt/pushflip/
├── dealer-keypair.json           # The game's dealer signing keypair — NEVER in git
├── zk-artifacts/
│   ├── shuffle_verify.wasm       # witness generator (~2 MB)
│   ├── shuffle_verify_final.zkey # proving key (~127 MB)
│   └── verification_key.json     # for local verification before send (optional but fast)
└── .env
```

### `.env` contents

```bash
# Solana RPC (Helius or self-hosted)
RPC_ENDPOINT=https://mainnet.helius-rpc.com/?api-key=...   # or devnet
WS_ENDPOINT=wss://mainnet.helius-rpc.com/?api-key=...

# Program + game
PROGRAM_ID=HQLeAQc84WLz8buHM5JAJGBjNJjwc6Fpxts8jSMaW3px
GAME_ID=1

# Dealer signer
DEALER_KEYPAIR_PATH=/opt/pushflip/dealer-keypair.json

# ZK artifacts
ZK_WASM_PATH=/opt/pushflip/zk-artifacts/shuffle_verify.wasm
ZK_ZKEY_PATH=/opt/pushflip/zk-artifacts/shuffle_verify_final.zkey
ZK_VKEY_PATH=/opt/pushflip/zk-artifacts/verification_key.json

# Compute budget for commit_deck (real Groth16 verify eats ~86K on-chain CU;
# smoke-test uses 400K to leave headroom). See scripts/smoke-test.ts.
COMMIT_DECK_CU_LIMIT=400000

# Observability
LOG_LEVEL=info
```

### Dealer keypair permissions

```bash
# Correct
-rw------- 1 pushflip pushflip 227 dealer-keypair.json

# Run `solana-keygen new --outfile /opt/pushflip/dealer-keypair.json` as the service user.
# Same ENOENT / EACCES / JSON-parse error paths that loadCliKeypair handles —
# see scripts/lib/script-helpers.ts.
```

The dealer keypair must match the `dealer` field in the on-chain `GameSession`. Mismatch → `commit_deck` fails at the authority signature check. If you rotate the dealer keypair, you must `initialize` a new game or accept that the current game is wedged (there's no on-chain instruction to update the dealer without authority consent — this is deliberate, see [Threat Model](../architecture/threat-model.md)).

### ZK artifacts

The proving key is large (~127 MB) and has an irreversible trusted setup: once it's shipped, the verifying key is pinned by a snapshot fingerprint test in [`program/src/zk/verifying_key.rs`](https://github.com/Panmoni/pushflip/blob/main/program/src/zk/verifying_key.rs). If you replace the `.zkey` with a different one, the on-chain verifier rejects every proof until the program is also upgraded.

The rebuild procedure is in [`zk-circuits/README.md`](https://github.com/Panmoni/pushflip/blob/main/zk-circuits/README.md); do not do this unless you also plan to redeploy the program.

## Process management

### systemd unit (`/etc/systemd/system/pushflip-dealer.service`)

```ini
[Unit]
Description=PushFlip ZK Dealer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pushflip
Group=pushflip
WorkingDirectory=/opt/pushflip/dealer
EnvironmentFile=/opt/pushflip/.env
ExecStart=/usr/bin/node --enable-source-maps ./dist/index.js

# Restart forever, but with backoff so a proof-gen crash loop doesn't thrash the box
Restart=always
RestartSec=5
StartLimitBurst=5
StartLimitIntervalSec=60

# Memory cap — Node default is unbounded, zkey load hits ~1.5GB
MemoryMax=2G

# File descriptors — snarkjs opens several fds during proof gen
LimitNOFILE=4096

# Logs to journald
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable + start:

```bash
systemctl daemon-reload
systemctl enable pushflip-dealer
systemctl start pushflip-dealer
journalctl -u pushflip-dealer -f     # tail live
```

### Docker alternative

If running under `docker-compose.yml` instead of systemd, the equivalent service block:

```yaml
services:
  dealer:
    build: ./dealer
    container_name: pushflip-dealer
    restart: unless-stopped
    mem_limit: 2g
    env_file: .env
    volumes:
      - ./dealer-keypair.json:/run/secrets/dealer-keypair.json:ro
      - ./zk-artifacts:/app/zk-artifacts:ro
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

## Health checks

The dealer exposes an HTTP health endpoint (to be added in the first production deployment — currently missing, tracked as part of Phase 5 work):

```
GET  /health      → 200 if ready, 503 if booting or if the zkey hasn't loaded
GET  /metrics     → Prometheus-format counters + histograms
```

Expected `/health` body:

```json
{
  "status": "ok",
  "uptime_seconds": 18472,
  "last_proof_generation_ms": 17832,
  "proofs_generated_total": 42,
  "rpc_endpoint_healthy": true,
  "dealer_sol_balance": 2.1
}
```

External monitoring should page on:

- `/health` returns non-200 for more than 60 s
- `last_proof_generation_ms` > 45_000 (double the expected 18–20 s budget)
- `dealer_sol_balance` < 0.1 SOL (fee-payer running dry)
- No `commit_deck` signatures from the dealer pubkey for > 30 min during active demos

## Expected baselines

| Metric | Typical | Alarm threshold |
|---|---|---|
| Proof-gen wall clock | 18 000 ms (±3 000) | > 45 000 ms |
| Proof-gen peak RAM | ~1.5 GB per worker | > 2 GB (systemd `MemoryMax`) |
| On-chain `commit_deck` CU | ~86 000 | > 200 000 (smoke-test budget) |
| `hit` CU | ~9 500 | > 12 000 (smoke-test budget) |
| Time from `start_round` to first `hit` reveal | < 1 s | > 5 s |
| Dealer SOL burn per round | ~10 000 lamports (~$0.00001) | — |

Baselines come from the devnet smoke-test CU regression guards ([`scripts/smoke-test.ts`](https://github.com/Panmoni/pushflip/blob/main/scripts/smoke-test.ts) `COMMIT_DECK_CU_BUDGET` / `HIT_CU_BUDGET`) and Pre-Mainnet 5.0.9 PR 1's measured values on the post-log-emission build.

## Error recovery

### Proof generation OOM

**Symptom.** `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory` in the journal; the service restarts under systemd.

**Cause.** Either the VPS is undersized (< 4 GB RAM), another process is consuming RAM during the proof burst, or Node is running with a smaller `--max-old-space-size` than the zkey needs.

**Fix.**

1. `free -h` — confirm available RAM is the issue.
2. If on VPS-1 (8 GB) and this is a recurring issue, upgrade to VPS-2 (12 GB) — see [Hosting & RPC](hosting-and-rpc.md).
3. As a stop-gap: `node --max-old-space-size=2048 dist/index.js` (raise from default 1.5 GB).

### RPC disconnect mid-`commit_deck`

**Symptom.** `SocketError: other side closed` in journal; `commit_deck` tx never lands. The on-chain game is stuck in `deck_committed=false`, no player can call `hit`.

**Cause.** Helius (or whatever RPC you're on) dropped the WebSocket mid-send. Devnet does this occasionally.

**Fix.**

- The dealer's `sendTx` helper already retries with exponential backoff (same pattern as [`scripts/lib/script-helpers.ts::retry`](https://github.com/Panmoni/pushflip/blob/main/scripts/lib/script-helpers.ts)). If the retry budget is exhausted, the dealer logs the error and leaves the round un-committed.
- Call `start_round` to reset the round state if the tx actually landed but the dealer didn't see the confirmation (idempotent on the dealer side — it tracks its own local state).
- If the tx truly never landed: the authority can call `end_round` to close the round; players can `leave_game` to recover their `PlayerState` rent. No tokens lost (`vault_ready=false` in dev mode; in production, stakes that were transferred into the vault are still there and `end_round` will pay them out on the next successful round).

### Blockhash expiry

**Symptom.** `Blockhash expired` error in the tx simulation, or `TransactionNotFoundError` when polling for confirmation.

**Cause.** The dealer built the tx, held it for > 60 s (Solana's blockhash validity window), then sent it.

**Fix.** The dealer builds the tx immediately before `sendAndConfirm` using `getLatestBlockhash` with `commitment: "confirmed"`. If this happens under load, the symptom is usually that proof generation took longer than 60 s for some reason — investigate the proof-gen latency first.

### Dealer falls behind (backlog)

**Symptom.** Multiple rounds queued but the dealer is still processing an earlier one. `last_proof_generation_ms` is normal but `/health` shows a queue depth > 1.

**Cause.** More games ran `start_round` simultaneously than the VPS has proof-gen cores. On VPS-1 with 4 vCPU this means > 2 simultaneous proofs (one per core; `snarkjs` is single-threaded per-worker).

**Fix.**

- If persistent: upgrade to a higher VPS tier. See [Hosting & RPC § VPS sizing](hosting-and-rpc.md#vps-sizing-for-2-concurrent-games).
- If transient: the queue drains automatically at ~20 s per proof.
- Emergency pressure-relief: call `end_round` on one of the affected games to give the dealer a round to breathe.

### Dealer keypair compromise

**Symptom.** Unexpected `commit_deck` signatures from the dealer's pubkey. You see on-chain commits you didn't initiate.

**Severity.** The compromised dealer can stack the deck for any game where it's the registered dealer. See [Threat Model → Dealer role](../architecture/threat-model.md#trust-assumptions-per-role).

**Fix.**

1. **Stop the dealer service immediately.** `systemctl stop pushflip-dealer`.
2. **Revoke all games bound to that dealer.** There's no on-chain "rotate dealer" instruction by design — the authority must `close_game` on each affected game and `initialize` a fresh one with a new dealer pubkey. For production this is a multi-minute to multi-hour outage depending on how many games are live.
3. **Rotate the authority keypair too if there's any chance it shared a code path with the dealer keypair.** Multisig on the authority (Pre-Mainnet 5.0.6) is the mainnet mitigation.
4. **Post-incident:** write up what leaked the keypair. If it was a VPS compromise, rebuild the box from scratch — don't try to "clean" it.

### Proof state lost (on-chain committed but dealer crashed before persisting local state)

**Symptom.** On-chain `GameSession` has `deck_committed=true` and a valid Merkle root, but the dealer process has no record of the shuffle — no permutation, no Merkle tree, no way to serve Merkle proofs for `hit` reveals.

**Severity.** The round is un-completable. Players called `start_round` and expect to `hit`, but the dealer can't produce the reveal proofs.

**Fix.**

1. **Currently: game is stuck.** The authority calls `end_round` (no winner, all players refunded via the rollover path up to 10 rounds or sweep to treasury) and everyone `leave_game`s.
2. **Future mitigation (Phase 5):** persist the dealer's permutation + Merkle tree to disk atomically after each `shuffle()` call, before submitting `commit_deck`. Tracked as an operational improvement — not blocking, since devnet crashes are rare and the recovery path exists.

## Observability

### Logs to ship

- `pushflip:*` — the on-chain event emissions from Pre-Mainnet 5.0.9 PR 1 (see `program/src/utils/events.rs`). Capture these via `logsNotifications({ mentions: [PROGRAM_ID] })` and index into whatever log stack you run (Loki, CloudWatch, etc.).
- Dealer process logs — `systemd-journald` or Docker json-file; rotate weekly.
- Tx signatures the dealer submits — captured in the dealer's own logs and cross-referenced against the on-chain `pushflip:commit_deck` event.

### Metrics to graph

- **`proof_generation_duration_seconds`** (histogram). Target p95 < 22 s.
- **`commit_deck_cu_consumed`** (histogram). Target p95 < 100 000.
- **`hit_cu_consumed`** (histogram). Target p95 < 10 000.
- **`dealer_sol_balance_lamports`** (gauge). Alarm if < 100 000 000 (0.1 SOL).
- **`rpc_errors_total`** (counter, labeled by error code). Alarm on sustained 429 rate — usually means you've outgrown the RPC tier.
- **`rounds_completed_total`** (counter).

### Grafana dashboard skeleton

1. Row 1: `proof_generation_duration_seconds` p50/p95/p99 + a raw scatter plot
2. Row 2: On-chain CU consumption for `commit_deck` and `hit` — these are the Pre-Mainnet 5.0.9 event log emissions being consumed by the metrics pipeline
3. Row 3: Dealer SOL balance + RPC error rate
4. Row 4: Rounds completed per hour

## Disaster recovery

| Scenario | Recovery |
|---|---|
| **VPS dies** | Spin up a new VPS, reinstall the dealer service from the repo (`git pull && pnpm install && pnpm --filter @pushflip/dealer build`), restore `dealer-keypair.json` + `.env` from your secrets vault, systemctl start. Ops time: 10–20 minutes. Games in flight are stuck until `start_round` is re-issued. |
| **Dealer keypair leaks** | See [Error recovery → Dealer keypair compromise](#dealer-keypair-compromise) above. |
| **Proving key / WASM corrupted** | Re-download from whatever artifact store you used at first deploy (GitHub releases, S3, etc.). The verifying key is pinned by a snapshot fingerprint test in the program, so if you accidentally use a different `.zkey` the on-chain verifier rejects every proof immediately — no silent failure mode. |
| **RPC provider goes down** | Switch endpoints via `.env` change + `systemctl restart pushflip-dealer`. Prep: keep a secondary RPC provider's API key warm in your secrets vault. |
| **Program upgrade introduces a regression** | Roll back the BPFLoaderUpgradeable program to the previous slot via `solana program deploy --program-id <PROGRAM_ID> <previous.so>`. The authority wallet must be available. CI should keep the previous `.so` as an artifact. |

## Today, exercise the dealer via smoke test

Until the first production deployment, the dealer is exercised end-to-end via the smoke test:

```bash
pnpm --filter @pushflip/scripts smoke-test
```

This runs the full lifecycle (initialize → join × 2 → shuffle + Groth16 proof gen → `commit_deck` → `start_round` → `hit` → `stay` → `end_round` → `leave_game` → `close_game`) against devnet, and is the regression guard for the [`sol_poseidon` syscall](../architecture/glossary.md#sol_poseidon-syscall) integration (see [Project History → Poseidon Stack Warning](../history/poseidon-stack-warning.md) for the incident that made that test critical).

The [CU regression assertions](https://github.com/Panmoni/pushflip/blob/main/scripts/smoke-test.ts) around `commit_deck` and `hit` are the mechanism that catches a dealer regression before it ships.

## See also

- [Hosting & RPC](hosting-and-rpc.md) — VPS sizing, OVH plan selection, Helius tiering
- [Threat Model → Dealer role](../architecture/threat-model.md#trust-assumptions-per-role) — what the dealer is trusted to do and what happens if compromised
- [ZK Research](../reference/zk-research.md) — why Groth16 over Plonk, why Poseidon, why arkworks vs snarkjs
- [Project History → Poseidon Stack Warning](../history/poseidon-stack-warning.md) — why the `sol_poseidon` syscall migration was critical
