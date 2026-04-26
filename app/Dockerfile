# pushflip-vite — production image for the React/Vite SPA.
#
# Build context is the repo root (the .dockerignore drops heavy paths).
# Build:
#   podman build -t localhost/pushflip-vite:latest -f app/Dockerfile .
#
# Build-time vars (Vite inlines these into the JS bundle):
#   VITE_FAUCET_URL       — same-origin path; `/api/faucet` keeps the
#                           browser on play.pushflip.xyz, no CORS.
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
# Build base: node:20-slim (Debian, glibc), NOT node:20-alpine.
# pnpm install hangs deterministically on Alpine in rootless podman
# (worker-thread futex deadlock; see faucet/Dockerfile header). Serve
# stage stays alpine because `serve` is pure JS with no native deps,
# so the runtime image stays small.

# --- build stage ---------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY app/package.json ./app/
COPY clients/js/package.json ./clients/js/
# --ignore-scripts: workaround for pnpm install hanging on postinstall
# scripts inside rootless podman on Alpine. Same issue caused yapbay's
# pnpm-test image to hang for 13 days (see ~/repos/yapbay/Containerfile
# which works around it by switching to npm ci entirely). Platform-
# specific binaries that vite/tsc need (esbuild, lightningcss, the
# rollup-linux-* native binding) are declared as optionalDependencies
# and install regardless of --ignore-scripts. Biome's postinstall
# (the likely culprit for the 10-min hang we saw) is dev-only and not
# needed for the production bundle build.
RUN pnpm install --filter @pushflip/app --filter @pushflip/client --frozen-lockfile --ignore-scripts

COPY clients/js ./clients/js
COPY app ./app

# Defaults match the dev expectation but production builds MUST pass
# all three via --build-arg. The deploy script does this.
ARG VITE_FAUCET_URL=/api/faucet
ARG VITE_RPC_ENDPOINT=https://api.devnet.solana.com
ARG VITE_RPC_WS_ENDPOINT=wss://api.devnet.solana.com
ENV VITE_FAUCET_URL=${VITE_FAUCET_URL}
ENV VITE_RPC_ENDPOINT=${VITE_RPC_ENDPOINT}
ENV VITE_RPC_WS_ENDPOINT=${VITE_RPC_WS_ENDPOINT}

RUN pnpm --filter @pushflip/app build

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
