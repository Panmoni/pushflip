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

FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10 --activate

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
