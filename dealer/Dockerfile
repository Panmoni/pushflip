# pushflip-dealer — production image for the ZK dealer service.
#
# Build context is the repo root (the .dockerignore drops heavy paths).
# Build:
#   podman build --network=host -t localhost/pushflip-dealer:latest -f dealer/Dockerfile .
#
# Runtime: see ~/.config/containers/systemd/pushflip-dealer.container
# on the deploy host. Env comes from .env.production (EnvironmentFile=);
# the dealer keypair is bind-mounted read-only from the host. ZK
# artifacts (wasm + zkey + vkey) are baked into the image — they're
# ~10 MB total and never change unless the circuit is recompiled, so
# baking is simpler than bind-mounting.
#
# This image carries NO secrets. The dealer keypair is bind-mounted at
# runtime; the Helius RPC URL comes via the env file. The ZK artifacts
# are public (the verification key is on-chain anyway).
#
# Base + install: same pattern as faucet/Dockerfile (Lessons #54-#56).
# `--network=host` on `podman build` is critical (netavark TCP
# keep-alive bug). pnpm replaced by npm. workspace:* rewritten to
# file: refs at build time.

FROM node:20-slim AS base
WORKDIR /app

# Copy workspace package.json files first (cache-friendly layer).
COPY package.json ./
COPY dealer/package.json ./dealer/
COPY clients/js/package.json ./clients/js/
COPY app/package.json ./app/
COPY faucet/package.json ./faucet/
COPY scripts/package.json ./scripts/
COPY house-ai/package.json ./house-ai/
COPY zk-circuits/package.json ./zk-circuits/

# Rewrite pnpm's workspace:* protocol to npm-readable file: paths
# (see Lesson #55 — npm 10/11 reject workspace: protocol).
RUN node -e "\
  const fs = require('fs'); \
  const map = { \
    '@pushflip/client': '../clients/js', \
    '@pushflip/dealer': '../dealer' \
  }; \
  for (const pkgPath of ['app/package.json', 'dealer/package.json', 'faucet/package.json', 'scripts/package.json']) { \
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); \
    for (const section of ['dependencies', 'devDependencies']) { \
      if (!pkg[section]) continue; \
      for (const [name, spec] of Object.entries(pkg[section])) { \
        if (spec === 'workspace:*' && map[name]) { \
          pkg[section][name] = 'file:' + map[name]; \
        } \
      } \
    } \
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2)); \
  }"

# Same install discipline as faucet/Dockerfile: --ignore-scripts to
# skip biome postinstalls; --prefer-offline + retry loop with cache
# mount to handle tucker network flakes (see Lesson #56).
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    bash -c "for attempt in 1 2 3 4 5; do \
      echo \"[npm install attempt \$attempt/5]\"; \
      npm install \
        --no-audit --no-fund --ignore-scripts \
        --prefer-offline \
        --fetch-retries=5 \
        --fetch-retry-mintimeout=20000 \
        --fetch-retry-maxtimeout=120000 \
        --fetch-timeout=600000 && exit 0; \
      echo \"[npm install attempt \$attempt failed; sleeping 30s before retry]\"; \
      sleep 30; \
    done; \
    echo '[npm install failed after 5 attempts]'; exit 1"

# Source. clients/js + dealer source come in via workspace symlinks
# (the file: refs in package.json point at sibling directories that
# we COPY here).
COPY clients/js ./clients/js
COPY dealer ./dealer

# ZK artifacts (wasm + zkey + vkey). The verification_key.json is
# referenced from the circuit-compile output. Bake into the image at
# /app/zk-artifacts/ so ZK_ARTIFACTS_DIR can point there.
COPY zk-circuits/build/shuffle_verify_js ./zk-artifacts/shuffle_verify_js
COPY zk-circuits/build/shuffle_verify_final.zkey ./zk-artifacts/shuffle_verify_final.zkey
COPY zk-circuits/build/verification_key.json ./zk-artifacts/verification_key.json

WORKDIR /app/dealer

# 3002 chosen because tucker has 3001 bound by pushflip-faucet. nginx
# routes /api/dealer/* to 127.0.0.1:3002.
EXPOSE 3002

CMD ["npm", "run", "service"]
