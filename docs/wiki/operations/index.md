---
title: Operations
diataxis_type: how-to
last_compiled: 2026-04-11
---

# Operations

Runbooks and operational guides for deploying and running PushFlip in production.

| Page | What it covers |
|---|---|
| **[Dealer Runbook](dealer-runbook.md)** | How to run the dealer service in production: env setup, snarkjs parameters, health checks, error recovery (stub — fleshed out when the dealer first deploys to production) |
| **[Hosting & RPC](hosting-and-rpc.md)** | Infrastructure sizing for 2 concurrent games, resource budget, VPS provider selection (OVH), Helius RPC plan, bottom-line monthly cost |
| **[Telegram Notifications](telegram-notifications.md)** | GitHub Actions workflow for push notifications: setup, verification, security, customization |
| **[Claude Hooks](claude-hooks.md)** | AI-assisted development safety nets: protected file guards, blocked command patterns, audit log, escape hatches |

## Related

- [Project History → Execution Plan](../history/index.md) for the deployment phasing and decisions log
- The repository [README](https://github.com/Panmoni/pushflip/blob/main/README.md) "Live Devnet Deployment" section for the current program ID and on-chain inspection commands
