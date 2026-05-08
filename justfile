# PushFlip — build commands

# Build the Solana program
build:
    CARGO_TARGET_DIR=target cargo build-sbf -- -p pushflip

# Run unit tests (program crate only)
test:
    cargo test -p pushflip

# Run integration tests (requires `just build` first)
test-integration:
    cargo test -p pushflip-tests

# Run all tests
test-all: build
    cargo test

# Run clippy lints
lint:
    cargo clippy --all-targets

# Deploy to configured cluster
deploy:
    solana program deploy target/deploy/pushflip.so

# Generate IDL from Shank macros
idl:
    shank idl -o idl -p pushflip

# Generate TypeScript + Rust clients from IDL
generate-client:
    npx @codama/cli generate -i idl/pushflip.json -o clients/

# --- TWA / Solana dApp Store (Seeker) -------------------------------
# Bubblewrap CLI: `npm i -g @bubblewrap/cli`. Requires JDK 17+ and Android SDK.
# Production manifest must be live at the URL below before twa-init / twa-update.

# One-time scaffold of the Android project inside twa/
twa-init:
    cd twa && bubblewrap init --manifest=https://play.pushflip.xyz/manifest.webmanifest

# Scaffold against a local `pnpm preview` (port 4173 by default).
# `pnpm dev` won't work — the PWA plugin is disabled in dev mode.
# Run `cd app && pnpm build && pnpm preview` first.
# Resulting AAB won't install on a real device — localhost in the AAB
# means the *device's* localhost, not yours. Useful only to validate
# the scaffold works; switch to twa-update against prod before a real build.
twa-init-local:
    cd twa && bubblewrap init --manifest=http://localhost:4173/manifest.webmanifest

# Build a signed AAB (output: twa/app-release-bundle.aab)
twa-build:
    cd twa && bubblewrap build

# Re-pull the deployed manifest after manifest.webmanifest changes ship
twa-update:
    cd twa && bubblewrap update
