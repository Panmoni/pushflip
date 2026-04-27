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
# Base: node:20-slim (Debian, glibc), NOT node:20-alpine (musl).
# pnpm install hangs deterministically on Alpine inside rootless
# podman due to a worker-thread/futex deadlock — see the matching
# yapbay-pushflip session log + the abandoned ~/repos/yapbay/Containerfile
# (renamed to .pnpm-test) that hung for 13 days on the same issue.
# Debian's glibc is the minimal-change fix; image size goes from ~50MB
# to ~150MB which is irrelevant on tucker (49 GB free).

FROM node:20-slim AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9 --activate

# Install workspace deps. Copy the lockfile + the package.json files
# of the workspaces we need first, so this layer caches across source
# edits. @pushflip/client is needed because faucet imports U64_MAX +
# TEST_FLIP_MINT + TOKEN_PROGRAM_ID + FLIP_DECIMALS from it.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY faucet/package.json ./faucet/
COPY clients/js/package.json ./clients/js/
# --ignore-scripts: workaround for pnpm install hanging on postinstall
# scripts inside rootless podman on Alpine. Same issue caused yapbay's
# pnpm-test image to hang for 13 days. Platform-specific binaries
# (esbuild, lightningcss, etc.) come via optionalDependencies and
# install regardless of --ignore-scripts. The faucet has no runtime
# binary deps, so this is strictly safe here.
RUN pnpm install --filter @pushflip/faucet --filter @pushflip/client --frozen-lockfile --ignore-scripts

# `--ignore-scripts` blocked better-sqlite3's prebuild-install, which
# normally downloads the precompiled native binding for the running
# Node version. `pnpm rebuild better-sqlite3` re-runs ONLY that
# package's install script in place, fetching the prebuild for our
# (node-20, linux-x64, glibc) target. better-sqlite3 11.x ships
# prebuilds for that target so the fetch path always wins; the
# build-from-source fallback (which would need python3/make/g++) is
# never exercised here.
#
# The `node -e "require('better-sqlite3')"` smoke is a load-bearing
# guard, not a paranoia check: if upstream ever drops the prebuild for
# our target tuple, `pnpm rebuild` silently succeeds (it tries the
# from-source fallback, which fails to find `python3`/`make`/`g++` and
# leaves the package in a broken state without a non-zero exit). The
# require() call fails loudly with "could not locate the bindings
# file", giving the operator a clear pointer to add the build deps.
# (Pre-Mainnet 5.0.10 — globally-unique-nickname registry needs the
# native sqlite binding at runtime.)
RUN pnpm rebuild better-sqlite3 \
    && node -e "require('better-sqlite3')" \
    || (echo "[faucet] FATAL: better-sqlite3 native binding failed to load. If this happened after a node/better-sqlite3 version bump, the prebuild may be missing for the target tuple — add 'apt-get install -y python3 make g++' before this RUN step to enable the from-source fallback." && exit 1)

# Source. clients/js is consumed in source form by @pushflip/faucet
# (no build step — pnpm workspace alias resolves to clients/js/src/index.ts).
COPY clients/js ./clients/js
COPY faucet ./faucet

WORKDIR /app/faucet

# 3001 matches PORT in .env.production + the nginx reverse proxy in
# server-config. Bind-mount the keypair into the path that
# FAUCET_KEYPAIR_PATH points at.
EXPOSE 3001

CMD ["pnpm", "start"]
