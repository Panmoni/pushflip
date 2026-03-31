# External Documentation Reference

When working with any of the following libraries or tools, use the Context7 MCP server (`resolve-library-id` then `query-docs`) to fetch current documentation before writing code. Do not rely on training data alone for API specifics.

## On-Chain (Rust / Solana Program)

- **Pinocchio** — zero-dependency Solana program framework (Anza). Entrypoints, account types, CPI, PDA signing
- **Solana Program Library (SPL)** — SPL Token program interfaces
- **Borsh** — binary serialization for account data
- **Shank** — IDL generation from Rust doc attributes
- **LiteSVM** — lightweight Solana VM for testing

## ZK / Cryptography

- **Groth16** — ZK-SNARK proof system (via arkworks or similar)
- **Poseidon** — ZK-friendly hash function for Merkle trees
- **solana-zk-sdk** — Solana's ZK primitives (if used)

## Client (TypeScript)

- **@solana/kit** — official Solana JS SDK (v2.x rewrite, maintained by Anza). NOT web3.js v1, NOT Gill
- **Kit Plugins** — composable extensions for Kit (transactions, signers, etc.)
- **Codama** — TypeScript client generation from Shank IDL

## Frontend

- **React** — UI framework
- **Vite** — build tool and dev server

## Toolchain

- **Rust** — language (edition 2021+)
- **Cargo** — build system, dependency management
- **Solana CLI** — validator, deploy, keygen, program management
- **Git** — version control
