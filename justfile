# PushFlip — build commands

# Build the Solana program
build:
    cargo build-sbf

# Run all tests
test:
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
