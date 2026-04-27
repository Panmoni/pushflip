# pushflip-vite — production image for the React/Vite SPA.
#
# Build context is the repo root (the .dockerignore drops heavy paths).
# Build:
#   podman build -t localhost/pushflip-vite:latest -f app/Dockerfile .
#
# Build-time vars (Vite inlines these into the JS bundle):
#   VITE_FAUCET_URL       — same-origin path; `/api/faucet` keeps the
#                           browser on play.pushflip.xyz, no CORS.
#   VITE_NICKNAME_URL     — same-origin path; `/api/nickname` for the
#                           globally-unique-nickname registry endpoint
#                           (Pre-Mainnet 5.0.10).
#   VITE_RPC_ENDPOINT     — Helius devnet HTTP URL. Public devnet's
#                           1 r/s limit is below baseline demand once
#                           the 5.0.9 PR 2 logsNotifications consumer
#                           is live, so we MUST bake in Helius.
#   VITE_RPC_WS_ENDPOINT  — Helius devnet WS URL (paired with the HTTP
#                           one — the app derives WS from HTTP at
#                           runtime if missing, but explicit is safer).
#
# Runtime: see ~/.config/containers/systemd/pushflip-vite.container
# on the deploy host. Image carries NO secrets — Helius URLs include
# an API key but it's a public devnet key with no economic value.
#
# Base: node:20-slim (Debian, glibc) for build, node:20-alpine for
# the serve stage (pure JS, no native deps so musl is fine).
#
# Install: `npm install` (NOT pnpm). pnpm install in containerized
# Node deadlocks deterministically at ~734 packages — libuv worker-
# thread futex hang. Documented as Lesson #54; re-hit during the
# 5.0.10 deploy with better-sqlite3 in the lockfile. yapbay-vite hit
# this same bug on the same host and resolved it by switching to
# npm; we do the same.

# --- build stage ---------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app

# Copy workspace package.json files first so this layer caches across
# source edits.
COPY package.json ./
COPY app/package.json ./app/
COPY clients/js/package.json ./clients/js/
COPY faucet/package.json ./faucet/
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

# --ignore-scripts: skip biome/ultracite postinstalls that aren't
# needed for the production bundle build. Vite + tsc come via npm's
# optionalDependencies (esbuild, lightningcss, rollup-linux-*) which
# install regardless of --ignore-scripts.
# --no-audit --no-fund: less noise + slightly faster.
# --omit=optional: drop platform-specific binaries we don't need on
# this Linux x64 build.
RUN npm install --no-audit --no-fund --ignore-scripts --omit=optional

COPY clients/js ./clients/js
COPY app ./app

# Defaults match the dev expectation but production builds MUST pass
# all four via --build-arg. The deploy script does this.
ARG VITE_FAUCET_URL=/api/faucet
ARG VITE_NICKNAME_URL=/api/nickname
ARG VITE_RPC_ENDPOINT=https://api.devnet.solana.com
ARG VITE_RPC_WS_ENDPOINT=wss://api.devnet.solana.com
ENV VITE_FAUCET_URL=${VITE_FAUCET_URL}
ENV VITE_NICKNAME_URL=${VITE_NICKNAME_URL}
ENV VITE_RPC_ENDPOINT=${VITE_RPC_ENDPOINT}
ENV VITE_RPC_WS_ENDPOINT=${VITE_RPC_WS_ENDPOINT}

# Run the workspace's build script via npm.
RUN npm run build --workspace=@pushflip/app

# --- serve stage ---------------------------------------------------
# Serves the built dist/ on port 5175. Matches the yapbay-vite pattern
# on tucker (5174). Both nginx + this container use Network=host so
# nginx reaches us at 127.0.0.1:5175 on the loopback.
FROM node:20-alpine AS serve
RUN npm install -g serve@14
WORKDIR /app
COPY --from=build /app/app/dist ./dist
EXPOSE 5175
CMD ["serve", "-s", "dist", "-l", "tcp://0.0.0.0:5175"]
