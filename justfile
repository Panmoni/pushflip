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
