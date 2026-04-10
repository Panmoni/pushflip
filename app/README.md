# @pushflip/app

Pushflip frontend — Vite + React 19 + TypeScript + Tailwind v4 + Biome (via
[Ultracite](https://ultracite.dev)) preset, wired to `@solana/kit` v6 with
Phantom + Solflare wallet adapters.

This is a workspace package inside the [pushflip](../README.md) monorepo. See
the root [CONTRIBUTING.md](../CONTRIBUTING.md) for project-wide conventions
and the [execution plan](../docs/EXECUTION_PLAN.md) (Phase 3B, Tasks 3.1 →
3.7) for what's being built here.

## Stack

| | |
|---|---|
| Build | Vite 8 |
| UI | React 19 + Tailwind CSS v4 (via `@tailwindcss/vite`) |
| Lint/format | Biome 2 + Ultracite preset (no ESLint, no Prettier) |
| Solana | `@solana/kit` v6 + `@solana/kit-plugin-{rpc,payer,instruction-plan}` + `@solana/kit-client-rpc` |
| Wallet | `@solana/wallet-adapter-{base,react,react-ui,phantom,solflare}` (web3.js v1 internally, bridged to Kit via `@solana/compat`) |
| Program client | `@pushflip/client` (workspace import) |

## Scripts

```bash
pnpm dev          # Vite dev server (localhost:5173)
pnpm typecheck    # tsc -b --noEmit (strict mode)
pnpm build        # tsc -b && vite build
pnpm preview      # Serve the production bundle locally
pnpm lint         # biome check
pnpm lint:fix     # biome check --fix
pnpm format       # biome format --write
```

## Conventions

- **Filenames are kebab-case** (`card.tsx`, `player-hand.tsx`) — enforced by
  Biome's `useFilenamingConvention` rule. Matches shadcn/ui defaults.
- **Strict TypeScript** — `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `exactOptionalPropertyTypes` are all on. Matches
  the rest of the workspace.
- **No `as any`, no non-null assertions in production code.** See
  [src/main.tsx](src/main.tsx) for the canonical pattern (explicit
  `if (!rootElement) throw …`).
- **No secrets in `.env`.** [.gitignore](.gitignore) blocks all `.env*`
  except `.env.example`.

## Status

Phase 3.1 + 3.2 complete. Scaffold + dependency stack + UI primitives
(button, card, dialog, sonner) + WalletProvider + QueryProvider + Kit RPC
clients in [src/lib/program.ts](src/lib/program.ts). Three program
integration hooks landed in [src/hooks/](src/hooks/):

- `useGameSession(gameId)` — fetch + subscribe to a `GameSession` PDA
- `usePlayerState(gameId)` — fetch + subscribe to the connected wallet's
  `PlayerState` PDA (uses the wallet adapter ↔ Kit bridge)
- `useGameActions(gameId)` — `joinRound`, `stay`, `burnSecondChance`,
  `burnScry`, `hit` (stub) with re-entry guards + symmetric success/error
  toasts. Signing goes through [src/lib/wallet-bridge.ts](src/lib/wallet-bridge.ts).

The current `<GameStatusPanel>` is a Phase 3.2 verification panel — it
exercises the read hooks against devnet. Task 3.3 will replace it with
the real `<GameBoard>`. See
[docs/EXECUTION_PLAN.md](../docs/EXECUTION_PLAN.md).
