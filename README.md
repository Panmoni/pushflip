# PushFlip

A crypto-native push-your-luck card game on Solana. Stake tokens, burn for power, and play against an AI-driven House -- all with provably fair shuffling via ZK proofs.

**[pushflip.xyz](https://pushflip.xyz)**

## What It Is

PushFlip is an on-chain card game with hit/stay mechanics, a $FLIP token economy, and zero-knowledge proof deck verification. Every shuffle is provably fair using Groth16 + Poseidon Merkle trees -- no trust required.

## Built With

- **Pinocchio** -- zero-dependency native Rust on Solana (no Anchor)
- **ZK-SNARKs** -- Groth16 proofs for provably fair deck shuffling
- **$FLIP Token** -- SPL token with stake-to-play and burn-for-power mechanics
- **@solana/kit** -- modern Solana TypeScript SDK
- **React + Vite** -- frontend
- **Shank + Codama** -- IDL generation and TypeScript client

## Features

- On-chain game sessions with PDA-managed state
- AI opponent ("The House") that plays autonomously
- ZK-verified deck commitment -- cards are revealed progressively with proof
- Token staking and burning integrated into gameplay
- Flip Advisor -- real-time probability assistant
