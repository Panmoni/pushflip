# pushflip-faucet — production image for the Hono test-$FLIP faucet.
#
# Build context is the repo root (the .dockerignore drops heavy paths).
# Build:
#   podman build -t localhost/pushflip-faucet:latest -f faucet/Dockerfile .
#
# Runtime: see ~/.config/containers/systemd/pushflip-faucet.container
# on the deploy host. Env comes from .env.production (EnvironmentFile=)
# and the keypair is bind-mounted read-only from the host filesystem.
# This image carries NO secrets.
#
# Base: node:20-slim (Debian, glibc).
#
# Install: `npm install` (NOT pnpm). pnpm install in containerized Node
# deadlocks deterministically at ~734 packages — libuv worker-thread
# futex hang. Documented as Lesson #54 in EXECUTION_PLAN.md and re-hit
# during the 5.0.10 deploy after better-sqlite3 was added to the
# lockfile (the package count changed but the deadlock signature did
# not). yapbay-vite hit this same bug months ago on this same host
# and resolved it by switching to npm; we do the same.
#
# Workspaces: root package.json declares a `workspaces` array that npm
# reads (pnpm prefers pnpm-workspace.yaml when both exist, so local
# pnpm dev is unaffected by the field).

FROM node:20-slim AS base
WORKDIR /app

# Install workspace deps. Copy the workspace package.json files first
# so this layer caches across source edits. @pushflip/client is needed
# because faucet imports U64_MAX + TEST_FLIP_MINT + TOKEN_PROGRAM_ID +
# FLIP_DECIMALS from it.
COPY package.json ./
COPY faucet/package.json ./faucet/
COPY clients/js/package.json ./clients/js/
COPY app/package.json ./app/
COPY scripts/package.json ./scripts/
COPY dealer/package.json ./dealer/
COPY house-ai/package.json ./house-ai/
COPY zk-circuits/package.json ./zk-circuits/

# Rewrite pnpm's `workspace:*` protocol into npm-readable relative
# `file:` paths. pnpm-only syntax breaks `npm install` with
# "Unsupported URL Type" (npm 10 + 11 both reject it). We can't just
# use `"*"` because pnpm interprets that as "fetch from registry"
# locally (kills `pnpm install` at dev time). Keep `workspace:*` in
# source for pnpm dev; rewrite per-Dockerfile for the npm container
# build. The map matches every cross-workspace dep in this monorepo;
# adding a new one means extending this list.
RUN node -e "\
  const fs = require('fs'); \
  const map = { \
    '@pushflip/client': '../clients/js', \
    '@pushflip/dealer': '../dealer' \
  }; \
  for (const pkgPath of ['app/package.json', 'faucet/package.json', 'scripts/package.json']) { \
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

# --ignore-scripts: skip postinstall hooks that previously triggered
# the same hang (biome/ultracite postinstalls do disk-heavy work). We
# explicitly run `npm rebuild better-sqlite3` after to fetch its
# native binding.
# --no-audit --no-fund: less noise + slightly faster.
# --omit=optional: drop platform-specific optional binaries we don't
# need (e.g. esbuild's macOS binaries on a Linux build).
RUN npm install --no-audit --no-fund --ignore-scripts --omit=optional

# `--ignore-scripts` blocked better-sqlite3's prebuild-install, which
# normally downloads the precompiled native binding for the running
# Node version. `npm rebuild better-sqlite3` re-runs ONLY that
# package's install script in place, fetching the prebuild for our
# (node-20, linux-x64, glibc) target. better-sqlite3 11.x ships
# prebuilds for that target so the fetch path always wins; the
# build-from-source fallback (which would need python3/make/g++) is
# never exercised here.
#
# The `node -e "require('better-sqlite3')"` smoke is a load-bearing
# guard, not a paranoia check: if upstream ever drops the prebuild
# for our target tuple, npm rebuild silently succeeds (it tries the
# from-source fallback, which fails to find python3/make/g++ and
# leaves the package in a broken state without a non-zero exit). The
# require() call fails loudly with "could not locate the bindings
# file", giving the operator a clear pointer to add the build deps.
# (Pre-Mainnet 5.0.10 — globally-unique-nickname registry needs the
# native sqlite binding at runtime.)
RUN npm rebuild better-sqlite3 \
    && node -e "require('better-sqlite3')" \
    || (echo "[faucet] FATAL: better-sqlite3 native binding failed to load. If this happened after a node/better-sqlite3 version bump, the prebuild may be missing for the target tuple — add 'apt-get install -y python3 make g++' before this RUN step to enable the from-source fallback." && exit 1)

# Source. clients/js is consumed in source form by @pushflip/faucet
# (no build step — the workspace symlink resolves to clients/js/src/index.ts).
COPY clients/js ./clients/js
COPY faucet ./faucet

WORKDIR /app/faucet

# 3001 matches PORT in .env.production + the nginx reverse proxy in
# server-config. Bind-mount the keypair into the path that
# FAUCET_KEYPAIR_PATH points at.
EXPOSE 3001

# `npm start` runs the workspace's "start" script (tsx src/index.ts).
CMD ["npm", "start"]
