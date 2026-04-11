---
title: Hosting and RPC
diataxis_type: reference
last_compiled: 2026-04-11
---

# Hosting and RPC Sizing

Infrastructure sizing and cost analysis for running PushFlip with up to **2 simultaneous games**. Numbers are grounded in the measured performance data in [README.md §Performance and Costs](https://github.com/Panmoni/pushflip/blob/main/README.md#performance-and-costs) and the architecture described in [EXECUTION_PLAN.md](https://github.com/Panmoni/pushflip/blob/main/docs/EXECUTION_PLAN.md).

---

## What actually needs hosting

The Solana program itself runs on validator network — not our problem. What we self-host is:

| Component | What it is | Resource profile |
|---|---|---|
| **Frontend** | Vite/React SPA behind nginx | Static files, negligible |
| **ZK Dealer** ([dealer/](https://github.com/Panmoni/pushflip/blob/main/dealer)) | Node.js + snarkjs WASM, generates one Groth16 proof per round | **The only heavy thing.** ~18–30 s single-threaded CPU burst, ~1–1.5 GB RAM (127 MB zkey + witness generation for 362 K constraints) |
| **House AI** ([house-ai/](https://github.com/Panmoni/pushflip/blob/main/house-ai)) | Node.js bot polling RPC, playing as the in-game opponent | Light: a few hundred MB, mostly idle |
| **Solana RPC** | Helius (third-party) | Not self-hosted — see [EXECUTION_PLAN.md:2776](https://github.com/Panmoni/pushflip/blob/main/docs/EXECUTION_PLAN.md#L2776) |

The Podman/Docker + nginx deployment choice is already locked in at [EXECUTION_PLAN.md:206-207](https://github.com/Panmoni/pushflip/blob/main/docs/EXECUTION_PLAN.md#L206-L207).

---

## VPS sizing for 2 concurrent games

The bottleneck is the dealer's proof generation. `snarkjs` is single-threaded WASM, so two simultaneous shuffles want **two physical cores** for ~30 s each. After that burst the box is mostly idle — every other on-chain instruction is sub-second and a few thousand CU.

| Resource | Minimum (2 games) | Comfortable headroom |
|---|---|---|
| vCPU | 2 (one per concurrent proof) | 4 |
| RAM | 4 GB (2× ~1.5 GB proof workers + nginx + 2× House AI + OS) | 8 GB |
| Disk | 20 GB (zkey is 127 MB, plus images/logs) | 40 GB |
| Bandwidth | Trivial — RPC calls go out to Helius, frontend is tiny | — |

### Why memory, not CPU, is the hard limit
Two dealer workers each loading the 127 MB zkey plus witness arrays will consume ~3 GB during the shuffle burst. A 2 GB VPS will OOM. **Do not go below 4 GB.**

### Why "2 games" = "2 proofs", not "2 × players"
Proof generation scales linearly with concurrent rounds, *not* with concurrent players. A 4-player game and a 1-player game cost the dealer the same — one Groth16 proof per round. So "2 simultaneous games" means at most 2 proofs in flight, never more.

---

## Provider: OVH (not Hetzner)

**Hetzner is out.** Their acceptable-use policies are hostile toward crypto-adjacent workloads, and PushFlip — a Solana game with on-chain token mechanics and a dealer service hammering RPC — fits the profile they sometimes flag. Default to **OVH**, which is crypto-friendly and similarly priced.

### Current [OVH VPS pricing](https://us.ovhcloud.com/vps/) (2026)

| Plan | $/mo | vCPU | RAM | Storage | Bandwidth |
|---|---:|---:|---:|---|---|
| **VPS-1** | **$6.46** | **4** | **8 GB** | 75 GB SSD | 400 Mbps |
| VPS-2 | $9.99 | 6 | 12 GB | 100 GB NVMe | 1 Gbps |
| VPS-3 | $19.97 | 8 | 24 GB | 200 GB NVMe | 1.5 Gbps |
| VPS-4 | $36.98 | 12 | 48 GB | 300 GB NVMe | 2 Gbps (SOLD OUT) |
| VPS-5 | $54.82 | 16 | 64 GB | 350 GB NVMe | 2.5 Gbps (SOLD OUT) |
| VPS-6 | $73.10 | 24 | 96 GB | 400 GB NVMe | 3 Gbps (SOLD OUT) |

### The pick

**VPS-1 at $6.46/mo.** 4 vCPU + 8 GB RAM comfortably covers 2 concurrent dealers (each burning ~1.5 GB and one core for ~30 s during the shuffle proof) plus nginx, 2× House AI, and OS overhead.

**Upgrade trigger:** if we want NVMe storage (VPS-1 is plain SSD — fine here because the hot path is RAM-bound) or headroom beyond 2 concurrent games, step up to **VPS-2 at $9.99/mo** (6 vCPU / 12 GB / NVMe).

---

## Helius RPC plan

### Current [Helius pricing](https://www.helius.dev/pricing) (2026)

| Plan | $/mo | Credits/mo | RPC rate | sendTx | Networks |
|---|---:|---:|---:|---:|---|
| **Free** | $0 | 1 M | 10 req/s | 1/s | Devnet + Mainnet |
| **Developer** | $49 ($24.50 first mo) | 10 M | 50 req/s | 5/s | **Devnet only** |
| Business | $499 | 100 M | 200 req/s | 50/s | Devnet + Mainnet |
| Professional | $999 | 200 M | 500 req/s | 100/s | Devnet + Mainnet |

### Traffic math for 2 concurrent games

What actually hits the RPC:
- **Dealer** — idle most of the time; fires a burst of `sendTransaction` + `getSignatureStatuses` once per round
- **House AI** (×2, one per game) — polls game state to detect its turn; dominant cost if polling instead of subscribing
- **Frontend** (0–8 players) — reads game state, sends player txs, subscribes to updates

Back-of-envelope, assuming WebSocket subscriptions for state changes (not polling) and 2 games running 24/7:
- Backend services: ~30–60 req/min average, spiky up to ~10 req/s during round transitions
- Frontend: ~5–10 req/min per active player
- **Monthly total: ~3–5 M credits**

### What to actually buy

#### Phase 1 — devnet MVP (where PushFlip currently lives)
**Helius Free ($0/mo).** 1 M credits/month is tight but workable *if* WebSocket subscriptions replace polling, and if games run on-demand for demos rather than 24/7. The **10 req/s rate limit** is the real risk, not the credit count.

#### Phase 2 — active demo phase on devnet
**Helius Developer ($49/mo, $24.50 first month).** The sweet spot: 10 M credits, 50 req/s, chat support, devnet-only (Helius priced this tier specifically for pre-launch devs). For an early-stage project staying on devnet, **this is the ceiling.**

#### Phase 3 — mainnet (only if/when actually launching)
The Developer plan doesn't cover mainnet, so it jumps straight to **Business at $499/mo**. That's a 10× cliff. Mitigations if/when crossing this bridge:
- Try **QuickNode** or **Triton** — they have mainnet entry tiers around $10–50/mo that could handle 2 games comfortably.
- Use a public mainnet RPC (Solana Foundation) for reads and only use paid RPC for `sendTransaction`, which has far lower volume.
- Helius Business is only worth paying for once there are actual mainnet users who need LaserStream / enhanced APIs.

### Architectural decisions that push the RPC cost down

1. **Prefer WebSockets over polling.** `accountSubscribe` for game state costs almost nothing per update compared to polling `getAccountInfo` every 2 s. This single choice can push us from "needs Developer tier" to "Free tier is fine." Kit Plugins support this directly — see [EXECUTION_PLAN.md:2209](https://github.com/Panmoni/pushflip/blob/main/docs/EXECUTION_PLAN.md#L2209).
2. **Co-locate House AI with the dealer on the same VPS** so one RPC client, one connection, one auth token serves both. Don't run them as separate Helius subscribers.
3. **Free tier's 10 req/s is a hard wall, not a soft one.** If the House AI and dealer both spike at round transitions, expect 429s. Add jitter + exponential backoff in the RPC wrapper from day one — cheaper than upgrading the plan.

---

## Bottom-line totals

| Phase | OVH | Helius | Total |
|---|---:|---:|---:|
| Devnet MVP (on-demand demos) | $6.46/mo | $0/mo | **$6.46/mo** |
| Devnet active (24/7 demos) | $6.46/mo | $49/mo | **$55.46/mo** |
| Mainnet (if launched) | $6.46/mo | $499/mo (or $10–50 via QuickNode/Triton) | $506/mo worst case, ~$56 best case |

For an early-stage Solana project staying on devnet, the realistic spread is **$6–$55/mo**.

---

## Sources

- [Helius Pricing](https://www.helius.dev/pricing)
- [OVHcloud VPS](https://us.ovhcloud.com/vps/)
- [OVHcloud VPS Comparison](https://us.ovhcloud.com/vps/compare/)
- [README.md §Performance and Costs](https://github.com/Panmoni/pushflip/blob/main/README.md#performance-and-costs) — measured proof-gen latency and per-tx fees
- [EXECUTION_PLAN.md:206-207](https://github.com/Panmoni/pushflip/blob/main/docs/EXECUTION_PLAN.md#L206-L207) — Podman/Docker + nginx deployment decision
- [EXECUTION_PLAN.md:2776](https://github.com/Panmoni/pushflip/blob/main/docs/EXECUTION_PLAN.md#L2776) — rate-limit risk note for public devnet RPC
