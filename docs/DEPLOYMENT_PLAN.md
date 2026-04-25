# Deploy pushflip to tucker — Implementation Plan

## Context

**Goal.** Get a public HTTPS URL (`https://play.pushflip.xyz`) serving the frontend + a working one-click test-`$FLIP` faucet, backed by the on-chain devnet program that's already deployed. This is the first public-facing deploy of this project. Mainnet is far away; this is a devnet demo that stays up for months.

**Why today.** The JoinGameDialog "Get test $FLIP" button needs a running faucet service to work. Localhost is useless for strangers + for a portfolio link. 5 of 9 pre-mainnet items are shipped; the stack is feature-complete for a demo. Waiting for "perfect" is wrong.

**Why "ease of redeploy" is the top design goal.** PR 2 (event feed rewrite) ships tomorrow. That's at least one redeploy. Every subsequent Pre-Mainnet item (5.0.6 `$FLIP` metadata, 5.0.2 threshold randomness, Phase 4 House AI) will also need a redeploy. The deploy flow must be `one command from the dev machine` → new code live — not a multi-step manual process that decays.

**Target host: tucker (Panmoni production VPS).** Discovered state:

- Ubuntu 25.10, 4 vCPU, 7.6 GB RAM (6 GB free), 72 GB SSD (49 GB free — 33% used, comfortable headroom)
- Already runs: postgres 18.1, listmonk v5.1.0, redis 8.4.0, yapbay-vite, yapbay-api, yapbay-pricing
- **Container runtime: podman 5.4.2** via systemd quadlets (not docker-compose)
- **nginx 1.29.4 in a rootful podman container** binds 80/443, config at `/home/george9874/repos/server-config/nginx/conf.d/` (bind-mounted into the container read-only; reload via `nginx -s reload`)
- Let's Encrypt via certbot, webroot at `/var/www/certbot/`, live certs at `/etc/letsencrypt/live/`
- Quadlet pattern: `~/.config/containers/systemd/*.container` — each file is a systemd unit that podman-generate-systemd picks up. Reload with `systemctl --user daemon-reload && systemctl --user restart <name>`
- Existing pods: `nginx.pod` (rootful, Network=host), `yapbay.pod` (rootless, Network=host). nginx in its pod reaches app pods via `127.0.0.1:<port>` on the host loopback.
- Fail2ban + SSH hardened to alt-port 2222

**Decision: tucker, not a new OVH VPS.**

- Everything we need (podman, nginx, certbot, SSL automation, fail2ban) is already installed and working.
- 6 GB free RAM + 49 GB free disk is plenty for pushflip's footprint (faucet ~256 MB, frontend static ~50 MB).
- The existing quadlet pattern gives us high-quality redeploy ergonomics for free — the deploy script is `git pull && podman build && systemctl restart`. This is ~20× less ops work than setting up a fresh OVH box from scratch.
- The one cost: disk pressure. At 67% full we have headroom, but a runaway log file or a misbuild could OOM the disk. Plan addresses via explicit `LogDriver=journald` (bounded) + a monthly `docker system prune` / `podman image prune` in the deploy script.
- **If/when a new OVH VPS makes sense** (mainnet deploy, dedicated pushflip infra): migration is a `quadlet → VPS` copy + DNS switch. Staying on tucker today doesn't lock us in.

**Decision: podman, not docker.** Matches tucker's existing pattern. Not doing docker-compose (which would fight with the running podman containers for 80/443). The quadlet convention makes each service a clean `systemctl --user` target with native journald logging, health checks, resource limits.

**Decision: dedicated faucet keypair.** Mint authority for `$FLIP` is currently the user's CLI wallet at `~/.config/solana/id.json` (3XXMLDEf…). Copying that keypair to tucker expands its blast radius — if tucker is ever compromised, the attacker gets the user's entire personal devnet wallet. Instead: generate a new keypair, transfer the `$FLIP` mint authority to it via `spl-token authorize`, ship the new keypair to tucker. The user's CLI wallet no longer mints; the faucet keypair on tucker does. If tucker is compromised, the attacker gets "can mint unlimited test `$FLIP`" which has zero monetary value. Clean blast-radius separation.

**Decision: same-origin path routing under `play.` subdomain.** The apex `pushflip.xyz` is already serving an existing static marketing site at the static-host of record (Cloudflare Pages or similar) and must NOT be touched. Cloudflare-side `www.pushflip.xyz` already 301-redirects to `pushflip.xyz`. The deployed game lives at `play.pushflip.xyz`: `play.pushflip.xyz/` serves the SPA; `play.pushflip.xyz/api/faucet` proxies to the faucet service. No CORS config, no second DNS record, single cert for `play.pushflip.xyz`. Cleaner production ergonomics + zero risk to the existing apex content.

**Out of scope for this deploy.**
- **The dealer.** Currently runs only during smoke tests; productionizing it is Phase 4 / Pre-Mainnet 5.2+. After this deploy, visitors to play.pushflip.xyz can: connect wallet, read game state, get test `$FLIP` via faucet, join the round. They cannot play a round because `commit_deck` + card reveals require the dealer. Demo is "you can see the game and touch the first on-chain write surface"; full gameplay needs follow-up dealer deploy.
- **Monitoring / alerting / metrics endpoints.** Journal logs are searchable via `journalctl -u pushflip-*` on tucker. Prometheus + Grafana is Phase 5+ work.
- **Backups of the faucet keypair.** Generated once, fine to regenerate if lost (transfer authority again). For mainnet this would be a multisig.

---

## Phased plan

Five phases. Each leaves the system in a working state (or pre-state if phase 0). You can pause between phases.

### Phase 0 — Preconditions (local dev machine, ~30 min)

**0.1 Generate the dedicated faucet keypair.**
- `solana-keygen new --outfile ~/.config/solana/pushflip-faucet.json --no-bip39-passphrase`
- Verify pubkey via `solana-keygen pubkey ~/.config/solana/pushflip-faucet.json` — record this address, it becomes the new mint authority.
- Fund it: `solana transfer <faucet-pubkey> 2 --url devnet` from the CLI wallet so the faucet has SOL for fees when it goes live.

**0.2 Transfer `$FLIP` mint authority to the faucet keypair.**
- `spl-token authorize 2KqqB7SRVaD98ZbVaiRWirxbaJv5ryNzkDRGweBZVryF mint <faucet-pubkey> --url devnet`
- Verify via `spl-token display 2KqqB7SR…` → "Mint authority" should now show the faucet pubkey.
- **Irreversible-ish**: only the new authority can transfer back. The faucet keypair file is now load-bearing for `$FLIP` operations.

**0.1b Back up the keypair BEFORE transferring authority.**
- Import the raw keypair JSON into a password manager (Bitwarden/1Password/etc.) as an attachment or a secret note. **Do this BEFORE running 0.2.**
- Verify you can retrieve it (close the manager, reopen, confirm the JSON is readable).
- **Rationale**: `spl-token authorize` is irreversible once the old authority relinquishes control. If the JSON is lost AFTER the transfer but BEFORE a backup exists, the mint is stranded forever. Bumping backup to before transfer eliminates that window.

**0.3 Update docs to reflect the new authority.**
- [docs/wiki/architecture/threat-model.md](../../repos/pushflip/docs/wiki/architecture/threat-model.md) "Trust assumptions per role / Treasury" section — mention faucet keypair as the new mint authority.
- [clients/js/src/constants.ts](../../repos/pushflip/clients/js/src/constants.ts) — **the TEST_FLIP_MINT docstring has the OLD authority pubkey `3XXMLDEf…` hardcoded inline**. Update that exact string to the new faucet pubkey (from Phase 0.1).
- [scripts/devnet-config.ts](../../repos/pushflip/scripts/devnet-config.ts) — re-exports the constant, but the file's own comment references "local CLI wallet". Verify the comment doesn't assert an old authority pubkey.
- [faucet/README.md](../../repos/pushflip/faucet/README.md) — document the transfer happened and record the new authority pubkey.

**0.4 Cloudflare DNS configuration — DONE 2026-04-15.**
- **Apex `pushflip.xyz`**: UNTOUCHED — already serves an existing static marketing site at the static-host of record. The deploy uses a subdomain instead so we can never accidentally take down the apex.
- **`www.pushflip.xyz`**: existing Cloudflare 301 → `pushflip.xyz` page rule. No A record needed.
- **`play.pushflip.xyz` → `192.99.247.151`** (tucker's public IP). Single A record, this is the deploy target.
- Proxy status: **Orange cloud DISABLED** (grey cloud / DNS-only) for `play.` during initial cert issuance — certbot's HTTP-01 challenge needs direct origin access. Re-enable orange cloud in Phase 5.5 after the first successful cert.
- TTL: 300 (5 min) during initial rollout, raise to auto after it's stable.

**0.5 Smoke check: verify the faucet service still works locally with the new keypair.**
- `FAUCET_KEYPAIR_PATH=~/.config/solana/pushflip-faucet.json RPC_ENDPOINT=https://api.devnet.solana.com WS_ENDPOINT=wss://api.devnet.solana.com PORT=3001 pnpm --filter @pushflip/faucet start`
- Hit `/health` — confirm balance > 0 and the authority pubkey matches.
- Hit `POST /faucet` with a fresh recipient — confirm the mint lands (this is the end-to-end "new keypair works" test).

**0.6 Commit + push the Phase 0 doc updates to `main`.**

Phase 1 clones the repo on tucker; whatever's on `origin/main` at that moment is what tucker sees. Commit/push before moving on:

- `git add docs/ clients/js/src/ scripts/devnet-config.ts faucet/README.md` (whichever were touched in 0.3)
- `git commit -m "docs: transfer \$FLIP mint authority to dedicated faucet keypair"`
- `git push origin main`

All subsequent Dockerfile + `.dockerignore` + `deploy-tucker.sh` work (Phase 1.4 + 4.1) is also committed-and-pushed-to-main before tucker picks it up. The deploy script explicitly deploys `origin/main` only — feature-branch work is invisible to the deploy pipeline.

**Done when:** new faucet keypair exists, is funded, IS the `$FLIP` mint authority, keypair JSON is backed up to a password manager, DNS points at tucker, local faucet smoke passes with the new keypair, Phase 0 doc updates are pushed to `main`.

---

### Phase 1 — Infrastructure on tucker (~60 min)

**1.1 Bootstrap the pushflip directory on tucker.**
- `ssh tucker`
- `cd ~/repos && git clone git@github.com:Panmoni/pushflip.git` (if not already cloned)
- `cd pushflip && pnpm install` (will install all workspaces including faucet)

**1.2 Ship the faucet keypair to tucker (secure copy).**
- On dev machine FIRST: `chmod 600 ~/.config/solana/pushflip-faucet.json && ls -la ~/.config/solana/pushflip-faucet.json` — confirm mode `-rw-------`. `scp`'s permission-preservation behavior varies across implementations; starting from 0600 on both ends is the only reliable way to avoid a world-readable keypair.
- Transfer: `scp ~/.config/solana/pushflip-faucet.json tucker:~/.config/solana/pushflip-faucet.json`
- On tucker: `chmod 600 ~/.config/solana/pushflip-faucet.json && ls -la ~/.config/solana/pushflip-faucet.json` — re-force 0600 idempotently + verify.
- Verify identity: `ssh tucker "solana-keygen pubkey ~/.config/solana/pushflip-faucet.json"` → matches the pubkey from Phase 0.1.

**1.3 Create production `.env` files on tucker (not in git).**

`/home/george9874/repos/pushflip/faucet/.env.production`:
```
PORT=3001
ALLOWED_ORIGINS=https://play.pushflip.xyz,https://www.pushflip.xyz
FAUCET_KEYPAIR_PATH=/home/george9874/.config/solana/pushflip-faucet.json
RPC_ENDPOINT=https://devnet.helius-rpc.com/?api-key=<YOUR_HELIUS_KEY>
WS_ENDPOINT=wss://devnet.helius-rpc.com/?api-key=<YOUR_HELIUS_KEY>
FAUCET_AMOUNT_WHOLE_FLIP=1000
COOLDOWN_MINUTES=1440
LOG_LEVEL=info
```

**Helius is required at deploy time, not deferred.** Public devnet RPC (`https://api.devnet.solana.com`) is hard-rate-limited to ~1 req/s per IP, which is below baseline demand: a single faucet mint is 2–3 RPC calls (balance check + send + confirm), and the frontend issues N RPC calls per page load. Public RPC saturates at 2–3 concurrent users; the demo would visibly fail. Sign up for **Helius Free tier** ($0/month, 1M credits, 10 req/s) at [helius.dev](https://www.helius.dev/) before Phase 1 and grab a devnet-only API key. If later demo traffic saturates the Free tier (manifest as `429` responses in faucet logs), bump to Developer ($49/month, 50 req/s) by editing `.env.production` + `systemctl restart pushflip-faucet`. See [operations/hosting-and-rpc.md](wiki/operations/hosting-and-rpc.md) for the tier table.

**1.4 Write Dockerfiles + `.dockerignore` in the pushflip repo (committed).**

Three new files in the pushflip repo:

`.dockerignore` (repo root) — without this, `podman build` copies `node_modules/` (~1.1 GB), `target/` (~485 MB), and `wiki/.venv/` into the build context. Skipping them drops the context from ~2 GB to ~50 MB and build time from 5–10 min to 2–3 min:

```
node_modules
**/node_modules
target
wiki/.venv
wiki/site
.git
.claude
dist
**/dist
.DS_Store
*.log
```

`faucet/Dockerfile`:
```dockerfile
FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9 --activate

# Dependency install (cached)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY faucet/package.json ./faucet/
COPY clients/js/package.json ./clients/js/
RUN pnpm install --filter @pushflip/faucet --frozen-lockfile

# Source
COPY clients/js ./clients/js
COPY faucet ./faucet

WORKDIR /app/faucet
EXPOSE 3001
CMD ["pnpm", "start"]
```

`app/Dockerfile`:
```dockerfile
# --- build stage ---
FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY app/package.json ./app/
COPY clients/js/package.json ./clients/js/
RUN pnpm install --filter @pushflip/app --frozen-lockfile

COPY clients/js ./clients/js
COPY app ./app

# VITE_FAUCET_URL is a same-origin path, so the frontend works regardless
# of what hostname the browser loaded it from.
ARG VITE_FAUCET_URL=/api/faucet
ENV VITE_FAUCET_URL=${VITE_FAUCET_URL}
RUN pnpm --filter @pushflip/app build

# --- serve stage ---
FROM node:20-alpine AS serve
RUN npm install -g serve
WORKDIR /app
COPY --from=build /app/app/dist ./dist
EXPOSE 5175
CMD ["serve", "-s", "dist", "-l", "tcp://0.0.0.0:5175"]
```

(Port 5175 chosen because tucker already has 5174 bound by yapbay-vite. Picking clear-of-conflict port numbers per tenant.)

**1.5 Create the podman quadlets on tucker.**

> **How quadlets become systemd units.** A file named `pushflip.pod` generates `pushflip-pod.service`. A file `pushflip-faucet.container` generates `pushflip-faucet.service`. The generator runs when you run `systemctl --user daemon-reload`. Once generated, `systemctl --user start pushflip-faucet.service` triggers the pod (via `Requires=pushflip-pod.service` from the `Pod=` line) — starting a pod separately isn't usually needed. Status: `systemctl --user status <name>.service`. Logs: `journalctl --user -u <name>.service`.

`~/.config/containers/systemd/pushflip.pod`:
```
[Unit]
Description=PushFlip application pod
After=network-online.target
Wants=network-online.target

[Pod]
# Host network so nginx (also Network=host) reaches our services at
# 127.0.0.1:<port>. Matches yapbay.pod precedent.
PodName=pushflip
Network=host

[Service]
Restart=always

[Install]
WantedBy=default.target
```

`~/.config/containers/systemd/pushflip-faucet.container`:
```
[Unit]
Description=PushFlip test-$FLIP Faucet Service
After=network-online.target pushflip-pod.service
Wants=network-online.target pushflip-pod.service

[Container]
Image=localhost/pushflip-faucet:latest
ContainerName=pushflip-faucet
Pod=pushflip.pod
WorkingDir=/app/faucet

EnvironmentFile=/home/george9874/repos/pushflip/faucet/.env.production

# Keypair is bind-mounted read-only; the path inside the container
# matches FAUCET_KEYPAIR_PATH in .env.production.
Volume=/home/george9874/.config/solana/pushflip-faucet.json:/home/george9874/.config/solana/pushflip-faucet.json:ro

HealthCmd=wget -q --spider http://localhost:3001/health || exit 1
HealthInterval=30s
HealthTimeout=5s
HealthRetries=3
HealthStartPeriod=15s

PodmanArgs=--memory 512m --memory-reservation 256m

LogDriver=journald

[Service]
Restart=always
RestartSec=10s
TimeoutStartSec=120
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

`~/.config/containers/systemd/pushflip-vite.container`:
```
[Unit]
Description=PushFlip Vite App Server
After=network-online.target pushflip-pod.service
Wants=network-online.target pushflip-pod.service

[Container]
Image=localhost/pushflip-vite:latest
ContainerName=pushflip-vite
Pod=pushflip.pod
WorkingDir=/app

# serve -s dist on 5175 (see app/Dockerfile)
HealthCmd=wget -q --spider http://localhost:5175/ || exit 1
HealthInterval=30s
HealthTimeout=5s
HealthRetries=3
HealthStartPeriod=20s

PodmanArgs=--memory 256m --memory-reservation 128m

LogDriver=journald

[Service]
Restart=always
RestartSec=10s
TimeoutStartSec=120
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

**1.6 Create nginx site config on tucker.**

`/home/george9874/repos/server-config/nginx/conf.d/play.pushflip.xyz.conf`:
```nginx
# /home/george9874/repos/server-config/nginx/conf.d/play.pushflip.xyz.conf
#
# play.pushflip.xyz: SPA at /, faucet service at /api/faucet (same-origin).
# Companion service routing: NONE yet — dealer is not productionized.

# HTTP → HTTPS redirect + ACME challenge
server {
    listen 80;
    server_name  play.pushflip.xyz www.pushflip.xyz;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

# HTTPS
server {
    listen 443 ssl;
    http2 on;
    server_name  play.pushflip.xyz www.pushflip.xyz;

    ssl_certificate /etc/letsencrypt/live/play.pushflip.xyz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/play.pushflip.xyz/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:50m;
    ssl_session_tickets off;

    include /etc/nginx/snippets/cloudflare-real-ip.conf;
    include /etc/nginx/snippets/security-headers.conf;

    # Faucet service (Pre-Mainnet 5.0.7). Strip /api prefix before
    # proxying so the upstream sees the endpoint at /faucet (matches
    # faucet/src/server.ts routes). Rate limiting at this layer is
    # keyed on the true client IP via $http_cf_connecting_ip — using
    # $binary_remote_addr would resolve to Cloudflare's edge IP once
    # orange-cloud is re-enabled and collapse "5r/s per user" down to
    # "5r/s globally shared across all users" (17th heavy-duty review).
    location /api/ {
        # Drop "/api" → send "/faucet" upstream. The trailing slash on
        # proxy_pass is what enables path rewriting.
        proxy_pass http://127.0.0.1:3001/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout 30s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;

        # Minimal rate limiting at the nginx layer (separate from the
        # per-wallet cooldown in the faucet itself). Prevents a pure
        # connection-flood from overwhelming the service.
        limit_req zone=faucet_req burst=10 nodelay;
    }

    # Frontend SPA. Kit's subscription code uses WebSockets, hence the
    # Upgrade headers (same pattern as app.yapbay.com.conf).
    location / {
        proxy_pass http://127.0.0.1:5175;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}

# Rate-limit zone for the faucet (declared here since it's site-specific).
# Key is the Cloudflare-forwarded client IP, NOT $binary_remote_addr —
# when orange cloud is on, the direct remote addr is always a Cloudflare
# edge IP and the zone collapses to "5r/s globally" (17th review fix).
# When orange cloud is off (during initial cert issuance), this variable
# is empty and the limit acts as a no-op — which is fine: cert issuance
# happens from Let's Encrypt itself, not end users.
#
# This file is included from inside the http{} block (see nginx.conf
# `include /etc/nginx/conf.d/*.conf;`), so a top-level directive here
# IS in the http context and legal.
limit_req_zone $http_cf_connecting_ip zone=faucet_req:10m rate=5r/s;
```

**1.6b Reload nginx to pick up the new site config — BEFORE certbot runs.**

Certbot's HTTP-01 challenge depends on nginx serving the `/.well-known/acme-challenge/` location from `/var/www/certbot`. That location is in the new `play.pushflip.xyz.conf` — which nginx hasn't loaded yet. Without this step, certbot fails with 403/404 on the challenge.

- `sudo podman exec nginx nginx -t` (syntax check — MUST pass)
- `sudo podman exec nginx nginx -s reload`
- Verify: `curl -I http://play.pushflip.xyz/.well-known/acme-challenge/test` → 404 (NOT 403 — 404 means nginx served the location from /var/www/certbot and the test file just doesn't exist, which is exactly what certbot expects).

**1.7 Issue the SSL cert via certbot.**

- On tucker, with DNS pointing at the IP (Phase 0.4) and nginx config in place for port 80's ACME challenge:
  ```bash
  sudo certbot certonly --webroot -w /var/www/certbot \
    -d  play.pushflip.xyz -d www.pushflip.xyz \
    --agree-tos -n -m me@georgedonnelly.com
  ```
- Verify: `sudo ls /etc/letsencrypt/live/play.pushflip.xyz/` → should show `fullchain.pem` + `privkey.pem`.

**1.7b Verify SSL auto-renewal is active.**

If certbot's systemd timer isn't running, the cert expires in 90 days and every HTTPS request to  play.pushflip.xyz breaks. Trivial to verify:

- `sudo systemctl list-timers certbot.timer` → should show "active", next trigger within the next ~day
- `sudo systemctl status certbot.timer` → `Active: active (waiting)`
- If missing: `sudo systemctl enable --now certbot.timer`
- Dry-run the renewal path: `sudo certbot renew --dry-run` → must succeed without errors (this hits Let's Encrypt staging; no rate-limit concern).

**1.7c Pre-build disk check.**
- `ssh tucker "df -h / | tail -1"` — expected: **≥ 20 GB free** before building. pushflip-vite + pushflip-faucet + build cache intermediates = ~500–800 MB; running < 20 GB free invites disk-full mid-build.
- If tight: `ssh tucker "podman image prune -a -f && podman system prune -f"` first.

**Done when:** tucker has the repo cloned, keypair in place, `.env.production` written (with Helius key), quadlet files in place (not yet started), nginx config written AND RELOADED, certbot has issued the cert AND auto-renewal is verified active, ≥ 20 GB disk free.

---

### Phase 2 — Frontend deployment (~60 min)

**2.1 Build the frontend image on tucker.**
- `cd ~/repos/pushflip && podman build -t localhost/pushflip-vite:latest -f app/Dockerfile .`
- Expect ~2-3 min build time.
- Verify: `podman images | grep pushflip-vite`.

**2.2 Start the pushflip pod + vite container.**
- `systemctl --user daemon-reload`
- `systemctl --user start pushflip-pod.service pushflip-vite.service`
- Verify: `systemctl --user status pushflip-vite.service` → active; `curl http://localhost:5175/` → HTML response.

**2.3 Reload nginx.**
- `podman exec nginx nginx -t` (config syntax check)
- `podman exec nginx nginx -s reload`
- Verify: `curl -I https://play.pushflip.xyz/` → 200 OK, HTML content-type.

**2.4 Browser verification.**
- Open `https://play.pushflip.xyz/` from a fresh browser profile (no wallet state).
- Connect Phantom or Solflare on devnet.
- Verify the ClusterHint banner works; game state at game_id=2 loads; the Join button surfaces "You don't have a $FLIP token account yet."
- The faucet button will fail (backend not deployed yet) — expected until Phase 3.

**Done when:** `https://play.pushflip.xyz/` loads the SPA, wallet connects, game state reads correctly, the pre-faucet no-ATA branch renders (but "Get test $FLIP" click fails gracefully because the backend isn't up yet).

---

### Phase 3 — Faucet deployment (~60 min)

**3.1 Build the faucet image on tucker.**
- `cd ~/repos/pushflip && podman build -t localhost/pushflip-faucet:latest -f faucet/Dockerfile .`
- Verify: `podman images | grep pushflip-faucet`.

**3.2 Start the faucet container.**
- `systemctl --user start pushflip-faucet.service`
- Verify: `systemctl --user status pushflip-faucet.service` → active; `journalctl --user -u pushflip-faucet.service -n 20` should show the startup banner with the new authority pubkey.
- `curl http://localhost:3001/health` → JSON response.
- **Verify loopback binding** (not world-accessible): `ss -tlnp | grep 3001` → output should start with `LISTEN 0 … 127.0.0.1:3001` OR `[::1]:3001`. If you see `0.0.0.0:3001`, the faucet is reachable directly from the internet, bypassing nginx rate limiting — fix before proceeding (the pod should be `Network=host` but bound via Hono's default localhost-only behavior; verify `app.listen({ host: "127.0.0.1", … })` if binding is wrong).

**3.3 End-to-end faucet test via the public URL.**
- `curl -X POST https://play.pushflip.xyz/api/faucet -H "Content-Type: application/json" -d '{"recipient":"<fresh-generated-pubkey>"}'`
- Expect 200 + signature + explorer URL.
- Second identical request: 429 rate-limited.
- `solana balance <recipient> --url devnet` → 0 (no SOL needed!); `spl-token balance 2KqqB7SR… --owner <recipient> --url devnet` → 1000.

**3.4 Browser end-to-end test.**
- Reload `https://play.pushflip.xyz/` with a fresh wallet (0 SOL, no ATAs).
- Connect wallet, open Join dialog → "Get test $FLIP" button visible.
- Click it. Wallet does NOT prompt to sign (backend-paid). Confirmation toast appears with Explorer link.
- Balance updates in-dialog; user can now type a stake and click Join.

**Done when:** the end-to-end "stranger lands on  play.pushflip.xyz with 0 SOL, clicks one button, gets `$FLIP`, joins the round" flow works.

---

### Phase 4 — Redeploy ergonomics (~30 min)

**4.1 Add a `scripts/deploy-tucker.sh` to the pushflip repo.**

Design notes this script embodies:
- **Deploys `main` and only `main`.** Feature-branch deploys are unsupported; a flag is the next improvement, but today if you run this from a feature branch locally, only `main` on the remote gets redeployed. Loudly documented in the script header so no one silently loses work.
- **Does NOT touch `server-config`.** nginx config lives in a separate repo. Pulling it during a pushflip deploy risks yapbay/listmonk/etc. going down because of an in-between typo in a totally unrelated site config. If you change nginx config, run `deploy-server-config.sh` separately (future one-liner: `ssh tucker "cd ~/repos/server-config && git pull && sudo podman exec nginx nginx -t && sudo podman exec nginx nginx -s reload"`). Split responsibilities.
- **Captures pre-deploy image tags for rollback.** Keeps the previous `localhost/pushflip-vite:latest` + `localhost/pushflip-faucet:latest` as `localhost/pushflip-vite:prev` + `localhost/pushflip-faucet:prev` so a human can `podman tag :prev :latest && systemctl restart` if the new build is broken.
- **Health-checks both services** before declaring success.

```bash
#!/usr/bin/env bash
# scripts/deploy-tucker.sh
#
# One-shot production deploy to tucker. Pulls latest main, rebuilds
# images, restarts services. Idempotent; safe to re-run.
#
# IMPORTANT: This script deploys `main`, and ONLY `main`. A local
# feature-branch checkout does NOT push your feature branch to
# production — only the remote's main branch is deployed. If you need
# your changes live, merge them to main first. (Branch-parameterization
# is a future improvement; today this is hardcoded for safety.)
#
# This script does NOT manage the `server-config` repo (nginx config).
# Nginx changes for pushflip go through a separate deploy path to
# avoid coupling pushflip redeploys to unrelated site changes.
#
# Usage: bash scripts/deploy-tucker.sh
#
# Prerequisites:
#   - ssh alias `tucker` resolves to the production host
#   - `main` contains the change you want to deploy (push it first)
set -euo pipefail

REMOTE_HOST=tucker
REMOTE_REPO=/home/george9874/repos/pushflip

# --- Pre-flight ---
echo "[deploy] verifying ssh + disk headroom…"
ssh $REMOTE_HOST 'df -h / | tail -1 | awk "{ if (\$5+0 > 85) { print \"[deploy] FAIL: disk > 85% full: \"\$5; exit 1 } else { print \"  disk: \"\$4\" free (\"\$5\" used)\" } }"' || exit 1

# --- Save rollback tags ---
echo "[deploy] tagging current images as :prev for rollback…"
ssh $REMOTE_HOST 'for img in pushflip-vite pushflip-faucet; do podman tag localhost/$img:latest localhost/$img:prev 2>/dev/null || echo "  (no previous $img image — first deploy)"; done'

# --- Pull latest main ---
echo "[deploy] pulling latest main on $REMOTE_HOST…"
ssh $REMOTE_HOST "cd $REMOTE_REPO && git fetch origin main && git checkout main && git reset --hard origin/main && pnpm install --frozen-lockfile"

# --- Rebuild images ---
echo "[deploy] rebuilding pushflip-vite (~2–3 min)…"
ssh $REMOTE_HOST "cd $REMOTE_REPO && podman build -t localhost/pushflip-vite:latest -f app/Dockerfile ."

echo "[deploy] rebuilding pushflip-faucet (~1–2 min)…"
ssh $REMOTE_HOST "cd $REMOTE_REPO && podman build -t localhost/pushflip-faucet:latest -f faucet/Dockerfile ."

# --- Restart services ---
echo "[deploy] restarting services…"
ssh $REMOTE_HOST "systemctl --user restart pushflip-vite.service pushflip-faucet.service"

# --- Health-check ---
echo "[deploy] waiting for health (max 30s each)…"
for svc in pushflip-vite pushflip-faucet; do
  if ! ssh $REMOTE_HOST "timeout 30 bash -c 'until systemctl --user is-active --quiet $svc; do sleep 1; done'"; then
    echo "[deploy] FAIL: $svc did not come up within 30s."
    echo "[deploy] Rollback suggestion (run manually):"
    echo "  ssh $REMOTE_HOST 'podman tag localhost/$svc:prev localhost/$svc:latest && systemctl --user restart $svc.service'"
    exit 1
  fi
done

# --- End-to-end smoke ---
echo "[deploy] smoke check…"
curl -fsS https://play.pushflip.xyz/ -o /dev/null && echo "  frontend OK" || { echo "  [FAIL] frontend"; exit 1; }
curl -fsS https://play.pushflip.xyz/api/health -o /dev/null && echo "  faucet /health OK" || { echo "  [FAIL] faucet /health"; exit 1; }

echo "[deploy] ✓ done — live at https://play.pushflip.xyz/"
echo "[deploy] rollback if needed:"
echo "  ssh $REMOTE_HOST \"podman tag localhost/pushflip-vite:prev localhost/pushflip-vite:latest && podman tag localhost/pushflip-faucet:prev localhost/pushflip-faucet:latest && systemctl --user restart pushflip-vite.service pushflip-faucet.service\""
```

**4.2 Add a `deploy` target to any existing Just/Make file, if one exists.** Otherwise just document the script in `faucet/README.md` + `app/README.md` as the canonical deploy command.

**4.3 Smoke the full redeploy cycle.**
- Make a trivial change (e.g., a comment in `app/src/app.tsx`)
- Commit + push to main
- Run `bash scripts/deploy-tucker.sh` from the dev machine
- Verify the change is live at `https://play.pushflip.xyz/` within ~3 minutes
- **This IS the test that "redeploy is easy."** Don't skip it.

**4.4 Disk hygiene.**
- Add a cron or manual cleanup note to `faucet/README.md`: `ssh tucker "podman image prune -a -f"` monthly. Untagged images from previous builds accumulate; each ~200 MB.
- Alternative: parameterize the Dockerfiles to tag by git sha (`localhost/pushflip-vite:abc1234`) and keep only the last 3. Defer — overkill for weekly cadence.

**4.5 Rollback plan (test it before you need it).**

If a deploy goes live with a regression, recovery is fast thanks to the `:prev` tagging in the deploy script:

```bash
ssh tucker "podman tag localhost/pushflip-vite:prev localhost/pushflip-vite:latest \
         && podman tag localhost/pushflip-faucet:prev localhost/pushflip-faucet:latest \
         && systemctl --user restart pushflip-vite.service pushflip-faucet.service"
```

The deploy script prints this command on success for convenience. Test it once during Phase 4.3: after a successful deploy, run the rollback command; confirm the site comes back. Then re-run `scripts/deploy-tucker.sh` to get back to latest.

**Partial-failure scenarios.** The deploy script fails fast (health-check timeout) if either service doesn't come up, but it restarts BOTH services. That means a frontend build failure can briefly downgrade the faucet too. If this becomes painful, split the script into `deploy-vite.sh` + `deploy-faucet.sh`; for now the coupling is fine since both services' footprints are tiny and cold-start is sub-second.

**Done when:** `bash scripts/deploy-tucker.sh` from a clean local checkout produces a working live deploy. Dry-run takes ~3-5 min end to end. Rollback command tested once manually.

**4.6 Dealer-not-deployed UX message.**

A first-time visitor to  play.pushflip.xyz can connect, get `$FLIP`, and join — then the UI sits waiting for a round that never starts, because the dealer service isn't productionized yet. Add a dismissible banner (matching the existing `<ClusterHint>` component pattern) OR a prominent footer note:

> **Demo stage.** You can connect, mint test `$FLIP`, and join a round. Full gameplay (card reveals, scoring, payout) requires the dealer service, which isn't deployed yet — tracked as Phase 4 in [EXECUTION_PLAN.md](https://github.com/Panmoni/pushflip/blob/main/docs/EXECUTION_PLAN.md).

Implementation: new `app/src/components/misc/demo-stage-banner.tsx` modeled on [ClusterHint](https://github.com/Panmoni/pushflip/blob/main/app/src/components/wallet/cluster-hint.tsx). Mount it next to the ClusterHint banner near the app root. Persist dismissal via `sessionStorage` so it doesn't follow the user across tabs.

Scope this to ~15 min — a full component + mount + styling. Can also be deferred to the PR 2 session tomorrow if Phase 4 timing runs tight; the demo still works without the banner, it's just less self-explanatory.

---

### Phase 5 — Document + commit + CI notes (~30 min)

**5.1 Update [faucet/README.md](../../repos/pushflip/faucet/README.md)** with the production deploy notes:
- How to regenerate the faucet keypair (for recovery)
- How to check faucet health on the VPS (`journalctl --user -u pushflip-faucet.service`)
- How to rotate the cooldown value (edit `.env.production`, `systemctl restart`)

**5.2 Update [docs/wiki/operations/](../../repos/pushflip/docs/wiki/operations)** — add a new page: `operations/deploy-tucker.md` (how-to) documenting the deploy architecture. Link from `operations/index.md`.

**5.3 Update [docs/EXECUTION_PLAN.md](../../repos/pushflip/docs/EXECUTION_PLAN.md)** — add a Phase 5.1 DONE entry (if we want to count this as "the first public deploy"), or a new "Deployment" section that tracks:
- Current target: tucker
- Current URL: https://play.pushflip.xyz
- Deploy script: `scripts/deploy-tucker.sh`
- Future: migration plan to a dedicated OVH VPS at mainnet time

**5.4 Update [.claude/settings.json](../../repos/pushflip/.claude/settings.json)** allowlist for the new `podman build` / `systemctl --user` / `ssh tucker` patterns.

**5.5 Deferred (explicit follow-up list):**
- **Helius Developer tier** ($49/mo): upgrade from Free when faucet logs show sustained `429 Too Many Requests` from the RPC. Change: two URL fields in `.env.production` + `systemctl --user restart pushflip-faucet`. No redeploy needed.
- **Dealer productionization**: Phase 4 / Pre-Mainnet 5.2+. When it lands, add `pushflip-dealer.container` alongside faucet + vite. At that point the "Demo stage" banner from Phase 4.6 can be removed.
- **Cloudflare orange cloud** (CDN): after first cert issue, re-enable orange cloud in Cloudflare DNS settings (Phase 0.4's "grey cloud" was temporary). Re-run smoke test to confirm the rate-limit zone using `$http_cf_connecting_ip` behaves correctly under orange cloud.
- **Image pruning automation**: weekly cron via `podman system prune -f --filter "until=168h"` to drop images older than a week. Prevents the 2-3 GB accumulation over 6 months called out in the 17th review.
- **Keypair rotation SOP**: if the faucet keypair is suspected compromised or on any major milestone (annual, mainnet cutover), rotate. Procedure: generate new keypair, `spl-token authorize <mint> mint <new>` from the old (still live) keypair, `scp` new key to tucker, restart faucet, revoke old. Document in faucet/README.md.
- **CI**: GitHub Actions workflow that runs `scripts/deploy-tucker.sh` on `main` push is the next ergonomic step. Requires an SSH deploy key + GitHub secret. Defer to a dedicated session — the one-shot local deploy is good enough for now.
- **Monitoring/alerting**: Prometheus + Grafana is Phase 5+. Until then, `journalctl --user -u pushflip-{vite,faucet}.service -f` is the primary monitoring tool. Manual checks only.

---

## Critical files (paths to edit)

**New in the pushflip repo (committed):**
- `/home/george9874/repos/pushflip/.dockerignore` (drops node_modules/target/venv from build context — ~2 GB → ~50 MB saved)
- `/home/george9874/repos/pushflip/app/Dockerfile`
- `/home/george9874/repos/pushflip/faucet/Dockerfile`
- `/home/george9874/repos/pushflip/scripts/deploy-tucker.sh`
- `/home/george9874/repos/pushflip/app/src/components/misc/demo-stage-banner.tsx` (Phase 4.6, optional; reusable across play.pushflip.xyz's demo stage)
- `/home/george9874/repos/pushflip/docs/wiki/operations/deploy-tucker.md`

**Modified in the pushflip repo:**
- `/home/george9874/repos/pushflip/clients/js/src/constants.ts` (TEST_FLIP_MINT docstring: update mint authority)
- `/home/george9874/repos/pushflip/faucet/README.md` (production deploy notes)
- `/home/george9874/repos/pushflip/docs/wiki/architecture/threat-model.md` (Trust assumptions — faucet keypair is new mint authority)
- `/home/george9874/repos/pushflip/docs/EXECUTION_PLAN.md` (record the deploy)
- `/home/george9874/repos/pushflip/.claude/settings.json` (allowlist for new commands)

**New on tucker (NOT in pushflip repo — lives on the host):**
- `/home/george9874/.config/containers/systemd/pushflip.pod`
- `/home/george9874/.config/containers/systemd/pushflip-faucet.container`
- `/home/george9874/.config/containers/systemd/pushflip-vite.container`
- `/home/george9874/repos/pushflip/faucet/.env.production` (.gitignored by the .env rule; production-only values)
- `/home/george9874/.config/solana/pushflip-faucet.json` (0600, the faucet mint authority keypair)

**New in the server-config repo (committed to its own repo):**
- `/home/george9874/repos/server-config/nginx/conf.d/play.pushflip.xyz.conf`

---

## Existing patterns / utilities being reused

- **Quadlet systemd-generated services** — `/etc/containers/systemd/nginx.container` + all `~/.config/containers/systemd/*.container` on tucker. Same pattern for pushflip.
- **nginx config reload flow** — bind-mount of `/home/george9874/repos/server-config/nginx/conf.d/` into the container; edit in place + `nginx -s reload`.
- **[snippets/cloudflare-real-ip.conf](../../../repos/server-config/nginx/snippets/cloudflare-real-ip.conf) + [snippets/security-headers.conf](../../../repos/server-config/nginx/snippets/security-headers.conf)** — shared snippets; include in play.pushflip.xyz.conf verbatim.
- **certbot --webroot pattern** — same as issued for api.yapbay.com + app.yapbay.com.
- **Pod=pushflip.pod + Network=host** — matches the yapbay.pod + nginx.pod precedent; nginx in its pod reaches our services at 127.0.0.1:<port> on the host.
- **`serve -s dist` for Vite SPA** — used by yapbay-vite, proven pattern.
- **Cooldown/rate limit in faucet** — already shipped in [faucet/src/rate-limit.ts](../../repos/pushflip/faucet/src/rate-limit.ts). Don't rebuild.
- **`faucet/src/config.ts` env validation** — fail-fast at boot. The .env.production file is the single configuration surface for the deployed faucet.

---

## Verification

**End-to-end smoke checklist after Phase 3 completes:**

1. `curl -I https://play.pushflip.xyz/` → `200 OK`, HTML content-type, HSTS header present (via snippets/security-headers.conf)
2. `curl -sS https://play.pushflip.xyz/api/health` → JSON with `status: "ok"` and `authority: <new-faucet-pubkey>`
3. `curl -X POST -H "Content-Type: application/json" -d '{"recipient":"<fresh>"}' https://play.pushflip.xyz/api/faucet` → 200 + signature
4. Same request immediately: 429 rate-limited
5. Fresh browser, Phantom on devnet, 0 SOL, 0 `$FLIP` → click "Get test $FLIP" → confirmation toast → balance updates → stake+join succeeds (single signed tx)
6. `ssh tucker 'journalctl --user -u pushflip-faucet.service -n 20'` → shows startup banner + each mint as an `[faucet]` log line
7. `systemctl --user is-active pushflip-vite.service pushflip-faucet.service` → both `active`
8. `podman ps --format 'table {{.Names}}\t{{.Status}}'` → both containers `Up … (healthy)`

**Phase 4 redeploy test (the critical "easy" test):**

1. On dev machine: edit a comment in `app/src/app.tsx`, commit + push
2. `bash scripts/deploy-tucker.sh`
3. Time it. Goal: < 5 min.
4. Verify the change is live.
5. If the script fails or is > 5 min, iterate on the script before declaring Phase 4 done.

---

## Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Transferring mint authority is irreversible once old authority relinquishes | Medium | Phase 0.1b: back up keypair JSON to password manager BEFORE Phase 0.2 transfer. Recovery path if lost: regenerate keypair + new mint (breaks existing `$FLIP` ATAs) — devnet-only, acceptable. |
| Cloudflare orange cloud breaks certbot HTTP-01 | High (blocks Phase 1.7) | Keep orange cloud DISABLED during cert issuance (Phase 0.4). Re-enable in Phase 5.5 after the first successful cert. |
| SSL cert expires in 90 days, nothing renews it | High (blocks site availability) | Phase 1.7b verifies `certbot.timer` is active + `certbot renew --dry-run` passes. Load-bearing; NOT deferred. |
| `limit_req_zone` bypassed when Cloudflare is on | High | Keyed on `$http_cf_connecting_ip`, not `$binary_remote_addr` (documented in nginx config). Still works (no-op) when orange cloud is off. |
| tucker disk pressure (67% full, +~500MB for pushflip images) | Medium | Phase 1.7c checks `df -h / ≥ 20 GB free` before build. Weekly `podman system prune --filter "until=168h"` prevents accumulation. |
| Port 5175 collision with some existing service | Low | Verified via `ss -tlnp` during exploration — 5175 is clear. Guard: the quadlet pins the port; `systemctl start` fails fast if bound elsewhere. |
| nginx config typo takes down *all* sites on tucker | High | ALWAYS run `nginx -t` before `nginx -s reload`. The deploy script does this. **Deploy script does NOT touch `server-config`** (decoupled in Phase 4.1) — pushflip redeploys cannot break unrelated sites via server-config churn. |
| Faucet keypair leaks from tucker | Medium | Blast radius = "unlimited test-`$FLIP`" = zero monetary value. Defense in depth: mode 0600 (Phase 1.2), SSH on alt-port 2222 + fail2ban (existing), tucker user scope. Rotation SOP in Phase 5.5 deferred list. |
| Shared-user blast radius with yapbay on tucker | Medium | If `george9874` shell is compromised, faucet keypair + yapbay-api env + listmonk creds are all readable. Acceptable for devnet demo; mainnet-equivalent would use a dedicated UNIX user per service. |
| Public RPC throttles demo traffic (1 req/s hard limit) | High | Phase 1.3 uses Helius (Free tier, 10 req/s) from day one. Upgrade trigger documented (look for `429` in faucet logs). NOT a deferred concern. |
| Helius Free tier (1M credits, 10 req/s) saturates under demo load | Medium | Upgrade to Developer tier ($49/mo, 50 req/s) is one `.env.production` change + `systemctl restart`. See [operations/hosting-and-rpc.md](../../repos/pushflip/docs/wiki/operations/hosting-and-rpc.md). |
| Wallet adapter cluster-mismatch (user on mainnet-beta) | Low | Already handled by `<ClusterHint>` banner in the app. |
| PR 2 (event feed rewrite) ships tomorrow needing VITE_RPC_ENDPOINT config | Low | `VITE_RPC_ENDPOINT` wiring already exists in `app/src/lib/constants.ts`. Set at build time via `app/Dockerfile` ARG. |
| Deploy script silently uses `main`, discards feature-branch work | Medium | Documented in the script header (Phase 4.1) + explicitly re-stated in Phase 0.6. Future branch-parameterization is listed in Phase 5.5. |
| Dealer is not deployed | Informational | Demo stage banner (Phase 4.6) explains the scope. Visitors can connect, get `$FLIP`, join; full rounds need the Phase 4 dealer deploy. |
| Faucet bound to `0.0.0.0` instead of loopback bypasses nginx | Low | Phase 3.2 verifies `ss -tlnp \| grep 3001` shows `127.0.0.1:3001`. Hono's default + the quadlet's `Network=host` produce loopback-only binding. |
| Deploy fails partway → site in half-state | Medium | Phase 4.5 documents rollback via `:prev`-tag swap. Script prints the rollback command on failure. Tested once during Phase 4.3. |

---

## Plan readiness

**Wall-clock estimate:** ~4-5 hours across phases 0-4. Doable today (4:43 PM start → done by 9:00-9:30 PM local). Phase 5 (docs) can slide to tomorrow before PR 2 lands.

**Sequence today (4:43 PM start):**
1. Phase 0 (local, ~40 min): keypair + backup + authority transfer + DNS + doc updates + commit/push
2. Phase 1 (tucker, ~75 min): Helius signup, infra, nginx config + **reload** (1.6b), cert, **auto-renewal verify** (1.7b), **disk check** (1.7c)
3. Phase 2 (tucker, ~60 min): frontend deploy
4. Phase 3 (tucker, ~60 min): faucet deploy + port binding verify
5. Phase 4 (both, ~40 min): redeploy script + dry-run + rollback test + demo banner (optional, ~15 min)

**Sequence tomorrow:**
1. PR 2 (event feed rewrite, per existing `docs/EXECUTION_PLAN.md` Pre-Mainnet 5.0.9 spec)
2. `bash scripts/deploy-tucker.sh` — proves the redeploy flow with a real code change
3. Phase 5 (docs + wiki page + plan-doc update + `.claude/settings.json` allowlist) — after the "prove it works twice" moment

**If 17th review catches something I missed here, fold it back into this plan file before executing Phase 0.1.**

When this plan is approved via ExitPlanMode, start at Phase 0.1.
