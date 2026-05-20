# Ship pushflip to Solana Seeker — Implementation Plan

## Status — PLANNED, NOT STARTED (drafted 2026-04-29)

Targeting the Solana Seeker phone as a primary mobile distribution channel for pushflip, in preference to a Play Store TWA. The Seeker route eliminates the Play policy gate that previously blocked the TWA plan ([EXECUTION_PLAN.md](EXECUTION_PLAN.md) Phase 5.x deferred), trades that for a smaller-but-correct audience, and reuses the PWA + MWA work that the TWA plan already scopes.

**Biggest unknowns at draft time:**
- Whether the project ships mainnet before Seeker submission, or lists a devnet demo build first.
- Real Seed Vault integration cost — likely lower than generic MWA but unverified empirically.
- Solana dApp Store moderation latency on first-time publishers (reported anywhere from 1 day to 2 weeks across the dev community in 2025–early-2026).

---

## Why Seeker over Play Store

The Play Store TWA route flagged Google's policy gate as the killer risk: rejection and account-ban risk for crypto/gambling categories with no appeal. Seeker sidesteps the entire problem:

| Concern | Play Store TWA | Solana dApp Store (Seeker) |
|---|---|---|
| Crypto / staking / burns allowed | Heavily restricted | First-class — that's the platform thesis |
| Real-money push-your-luck card game | High rejection risk | Listed under "Games" without ceremony |
| Wallet integration | MWA awkward, fights Chrome | Seed Vault is the OS — MWA is built-in |
| Submission gate | Policy review, account-ban risk | Publish via Solana tx; soft moderation only |
| Audience match | Generic Android (~3B devices) | Crypto-native users (~150K Saga + Seeker installed base) |
| Revenue cut | 30% (after first $1M) + Play Billing required for "digital goods" | 0% cut, no billing intermediary |
| Distribution cost | $25 one-time + signing infra | ~0.05 SOL on-chain publishing tx + dApp Store CLI |

The Play Store was a mismatch. The Seeker / dApp Store is exactly the audience pushflip is built for.

---

## Prerequisites

These are blocking, in order:

1. **Phase 1 PWA shell shipped** (~5–6 hr per the prior PWA/TWA discussion: `manifest.webmanifest`, service worker, icon set, update-banner). The TWA build wraps this PWA, so the manifest and service worker MUST exist and validate before Bubblewrap can scaffold.
2. **Mobile Wallet Adapter integration shipped** (~6–11 hr per the prior plan). On Seeker, MWA flows through Seed Vault — no third-party wallet app required. The work is the same as generic Android MWA; the M2.1 spike still gates it.
3. **Dealer deployed to production** (currently code-complete, gated on operator action per `docs/EXECUTION_PLAN.md`). A Seeker user installing the app and finding "full gameplay needs the not-yet-deployed dealer" via `<DemoStageBanner>` is a credibility-burning first impression. Block Seeker submission on dealer being live.
4. **Mainnet decision** — see Open Questions. Seeker users expect mainnet by default; a devnet-only listing is technically valid but reads as a tech demo, not a product.
5. **Brand asset upgrade** — Seeker's dApp Store listing demands more than a 192×192 PWA icon: feature graphic (1920×1080), screenshots (≥4 at 1080×1920), short description (≤80 chars), full description (≤4000 chars), category, tags. The PWA shell only needed a logo set.
6. **Solana wallet with publishing keypair** — separate from the dealer keypair, the faucet keypair, and the user's CLI wallet. Same blast-radius separation pattern (Pre-Mainnet 5.0.7 / 5.2). The publisher pubkey is what gets recorded on-chain as the app's owner; rotating it later is a non-trivial migration.

---

## Context

**Solana dApp Store mechanics (as of 2026-04):**
- Publishing is on-chain. The CLI (`@solana-mobile/dapp-store-cli`) creates three NFTs/PDAs: one for the publisher identity, one per app, one per release. Each release pins a `manifest.json` + APK/AAB to a content-addressed storage layer (ShdwDrive, Filebase, or similar).
- A Seeker device's dApp Store browser reads on-chain releases, filters by moderation list (Solana Mobile maintains a soft denylist), and serves the AAB directly to the device.
- Updates: each release is a new on-chain version PDA. The dApp Store client picks the latest release per app PDA. There's no "promote to production" step — publishing the on-chain tx IS production.
- AAB signing: Seeker uses Android's standard signing, same as Play Store. Reusing a key across stores is fine technically but ties release cadences together.

**Seeker hardware/OS specifics that matter for pushflip:**
- Seed Vault is invoked via Solana's MWA protocol, but the auth flow is local (no Phantom/Solflare app round-trip) — faster, fewer failure modes than generic Android MWA.
- The dApp Store app is preinstalled and pinned. Launching pushflip from there registers an "installed app" record on-chain.
- Genesis Token (the early-adopter NFT) is queryable via standard token-account RPC. Optional UX: detect Genesis Token holders for a thank-you toast or visual flag.
- Saga devices run the same Seed Vault + dApp Store stack as Seeker — the listing reaches both fleets.

**What we already have working in pushflip's favor:**
- Wallet Standard auto-discovery (Pre-Mainnet 5.0.x) — adding the MWA adapter into [app/src/providers/wallet-provider.tsx](../app/src/providers/wallet-provider.tsx)'s wallets array is mechanical.
- [wallet-bridge.ts](../app/src/lib/wallet-bridge.ts) with documented Lesson #46 lifetime-stripping fix — the same code path covers MWA-returned `VersionedTransaction` instances.
- `<ClusterHint>` + `isWalletClusterMismatch` already handle cluster mismatches; will work unchanged with Seed Vault.
- Helius RPC tier covering the demo. Seeker traffic is small (~150K-installed-base ceiling); existing capacity holds.
- One-shot deploy script ([scripts/deploy-tucker.sh](../scripts/deploy-tucker.sh)) — Seeker submission doesn't touch tucker, but the PWA/MWA work that precedes it deploys via the same script.

---

## Phased plan

### Phase 0 — Prerequisites (gating, no Seeker-specific work)

Cannot start until all 6 prerequisites above are checked off. Tracked in [EXECUTION_PLAN.md](EXECUTION_PLAN.md) as their respective items (5.x). Seeker work proceeds in parallel with mainnet preparation only after dealer is live.

### Phase 1 — PWA foundation (~5–6 hr)

Inherits directly from the PWA conversion plan. Acceptance: Lighthouse PWA install audit green on `play.pushflip.xyz`.

Seeker-specific deltas vs. the generic PWA plan:
- `manifest.webmanifest` `categories: ["games"]` is sufficient — dApp Store reads its own metadata, not the manifest's. But the manifest is what Bubblewrap parses to scaffold the Android project, so accuracy matters.
- `theme_color` and `background_color` flow through to the Android splash screen via TWA — pick the dark `#0a0a0f` to match brand (already set in [app/index.html](../app/index.html) `<meta name="theme-color">`).
- Icons: produce a 512×512 maskable + 192×192 standard at minimum. dApp Store wants additional 1024×1024 source asset but reuses the PWA set otherwise.

### Phase 2 — Mobile Wallet Adapter + Seed Vault path (~6–11 hr)

Inherits from prior plan. Two Seeker-specific notes:

- The MWA adapter routes through Seed Vault automatically when running on Seeker. No separate Seed-Vault SDK integration is required for the MVP.
- Test the connect flow on Saga (older device, same Seed Vault) before relying on Seeker — Saga is the canonical compatibility floor.
- **`appIdentity.uri` MUST be `https://play.pushflip.xyz`** (or whichever domain hosts the PWA) so the MWA handshake's domain claim matches the assetlinks file from Phase 3. Mismatch fails the binding silently — same shape as Lesson #46.

### Phase 3 — TWA wrapping + Seeker-aware metadata (~3–5 hr)

Inherits Bubblewrap mechanics from the prior plan, with Seeker substitutions:

- File to add to `server-config` repo: `play.pushflip.xyz/.well-known/assetlinks.json`. Same JSON, same SHA-256 fingerprint registration. Used by both Play Store TWA AND Seeker dApp Store TWA, so the file does double duty if Play Store ever happens.
- Bubblewrap config: `display: "standalone"` (matches manifest), `orientation: "portrait"` (the game board is portrait-first per Pre-Mainnet 5.0.x responsive sweep), `enableNotifications: false` (no push setup yet — leaving room for Pre-Mainnet 5.0.9 PR 2 to wire it), `splashScreenFadeOutDuration: 300`.
- Package name: `xyz.pushflip.app` (reserve via Play Console regardless — defense against squatting on Play even if we don't ship there).
- Generate **one** signed AAB target. Picking devnet OR mainnet (see Open Questions #1) keeps the build pipeline simple. Two-target builds (devnet preview + mainnet release) double the ops surface area for marginal user benefit.

### Phase 4 — Solana dApp Store submission (~3–5 hr active + review queue)

**Setup:**
- Install `@solana-mobile/dapp-store-cli` globally on a dev machine.
- Generate the publisher keypair: `solana-keygen new --outfile ~/.config/solana/pushflip-publisher.json`. Fund with ~0.5 SOL (same pattern as dealer keypair). **This keypair represents the project's identity on the dApp Store and CANNOT be rotated without losing the publisher PDA. Treat it like the program upgrade authority — back it up, plan custody.**
- Configure storage backend (ShdwDrive or Filebase) for the AAB hosting. ShdwDrive is the path-of-least-resistance for crypto-native projects; takes a small SOL fee per upload.

**Files to author:**
- `dapp-store/config.yaml` — publisher details (name "Panmoni" or "pushflip", website, X/Twitter handle, contact email), app metadata (name, full description ≤4000 chars, short description ≤80 chars, category=Games, tags=`card-game`, `solana`, `zk`, `push-your-luck`).
- `dapp-store/assets/` — feature graphic 1920×1080, screenshots (≥4, at minimum: idle game board with cards drawn, mid-round with a hit/stay decision active, win-payout state, faucet/connect-wallet first-run flow), icon 1024×1024, optional 30-second gameplay video.
- `dapp-store/release-N/` — versioned per release; the AAB lands here.

**Submission sequence:**
1. `npx dapp-store create publisher --keypair pushflip-publisher.json` — one-time on-chain tx creating the publisher PDA.
2. `npx dapp-store create app --keypair pushflip-publisher.json` — one-time on-chain tx creating the app PDA.
3. `npx dapp-store create release --keypair pushflip-publisher.json` — per-release tx; publishes the AAB to ShdwDrive + writes the release PDA.
4. `npx dapp-store publish submit --keypair pushflip-publisher.json` — submits to Solana Mobile's moderation queue (off-chain review by the dApp Store team).
5. Wait for moderation outcome (1 day to ~2 weeks). If rejected, the rejection reason comes back via email; iterate the AAB and resubmit (each resubmission is a new on-chain release tx — small cost).

**Acceptance:**
- Real Seeker (or Saga as fallback) installs pushflip from the on-device dApp Store browser.
- Connect-wallet flow uses Seed Vault (not Phantom/Solflare apps).
- Faucet → mint test $FLIP → join Game 2 → play full round → see payout. End-to-end, no fallback to web.
- App appears in dApp Store search for "card game", "push your luck", "zk".

### Phase 5 — Seeker-native polish (optional, post-launch)

Nice-to-haves once the listing is live and we have ≥1 week of install data:

- **Genesis Token detection.** On wallet-connect, fetch token accounts; if Genesis Token PDA is present, render a `<GenesisHolderBadge>` in the wallet pill. Pure cosmetic; ~1 hr.
- **dApp Store deep links.** `solana-app://...` URLs that open straight to specific game states (lobby, faucet, advisor). Solana Mobile's deep-link spec is opt-in; ~2 hr if we do it.
- **Install referral attribution.** dApp Store passes a `referrer` param on first install; logging it from `app.tsx` first-render lets us correlate listings → conversions. ~1 hr + a small backend log.
- **Push notifications.** Once Pre-Mainnet 5.0.9 PR 2 ships the on-chain log streaming, we could wire Web Push for "your turn" / "round ending" alerts. Bubblewrap supports this; non-trivial; ~1 day. Defer until events PR ships.
- **Saga compatibility test pass.** Borrow or buy a Saga; verify identical UX. Saga's older Android version (Android 13 vs Seeker 14) occasionally surfaces edge cases.

---

## Critical path

```
Phase 0 (prerequisites — blocking)
  Dealer deployed ─┐
  Mainnet decision ┤
  PWA shell ───────┼─→ Phase 1 (PWA, ~5–6 hr) ─→ Phase 2 (MWA, ~6–11 hr) ─→ Phase 3 (TWA, ~3–5 hr) ─→ Phase 4 (dApp Store submit, ~3–5 hr active + queue)
  MWA spike + work ┤                                                                                              │
  Brand assets ────┤                                                                                              ▼
  Publisher keypair┘                                                                                       Phase 5 (polish, post-launch)
```

Phases 1, 2, 3 are sequential. Brand assets (prerequisite #5) and publisher keypair (#6) can be parallelized with Phase 1 work. Phase 4's "queue wait" is wall-clock dead time — start Phase 5 polish in parallel with the moderation review.

**Realistic calendar (active work hours, not wall-clock):**
- Total active: ~17–25 hours.
- Plus ~1–2 weeks of dApp Store moderation queue.
- Plus the mainnet-deployment work (out of scope here, owns its own plan).

---

## Biggest risks (ranked)

1. **Mainnet vs. devnet listing.** Listing devnet pushflip on the dApp Store is technically permitted but commercially weak — Seeker users expect to play with real value. Listing mainnet means committing to a mainnet program deploy, multisig upgrade authority, monitored RPC, real-money pot custody. That's a meaningfully bigger scope than the current Pre-Mainnet 5.x checklist. **This is the single biggest decision gating the entire plan.** Don't start Phase 4 until it's resolved.

2. **Publisher keypair custody.** The dApp Store publisher PDA cannot be reassigned. Losing the keypair = losing the listing. Mitigation: hardware wallet at submission time (Ledger or otherwise), back up to two physical locations, document in the dealer-style runbook. Treat with the same gravity as the program upgrade authority.

3. **Moderation rejection.** Soft moderation by Solana Mobile is less hostile than Google Play, but still real. Common reasons reported in 2025: incomplete metadata, screenshots that don't reflect actual gameplay, missing terms/privacy URL. Mitigation: read 5+ recently-shipped dApp Store listings before submitting; cross-reference our metadata against theirs.

4. **Phase 2 MWA bug shape.** Same Lesson #46 risk as the prior plan — `@solana/compat::fromVersionedTransaction` strips lifetime, and MWA-returned tx may surface a similarly-shaped wire-format bug. Mitigation: M2.1 spike up front; real-device test on Saga before declaring Phase 2 done; budget a full session for unexpected issues.

5. **Brand asset polish.** PWA-quality icons are insufficient for a dApp Store listing. The feature graphic + screenshots + 30-second video are the difference between "1 install per day" and "100 installs per day" once shipped. Don't underestimate the asset work; budget ~1 day with a designer if available.

6. **Seeker hardware availability for testing.** If no team member has a Seeker, every Phase 2/3/4 acceptance test routes through Saga or an emulator. Saga + Android Studio's MWA fake-wallet emulator covers ~95% of cases but misses Seed-Vault-specific quirks. Mitigation: budget for a Seeker (~$450) before Phase 4 acceptance; alternative is Solana Mobile's developer device program (free hardware in exchange for shipping commitment).

---

## Open questions

These need user input before kicking off:

1. **Mainnet or devnet for the first dApp Store release?** This is THE blocker. Three options:
   - **(A) Devnet demo first, mainnet upgrade later.** Lower risk, faster to ship, validates moderation flow. But Seeker users may bounce on "devnet only" and cement a "this is just a demo" reputation. Re-listing the same app post-mainnet still works (each release is a new PDA), but the first impression is set.
   - **(B) Mainnet at first listing.** Right audience match. Requires committing to mainnet now: program upgrade authority lockdown plan, real-`$FLIP` token economics decision, custody story for the pot, multisig setup. Significantly bigger prerequisite scope.
   - **(C) Wait until mainnet, then ship Seeker as the launch channel.** Best alignment but defers Seeker work indefinitely. Risk: mainnet deploy slips and Seeker momentum windows close.
   - **Recommendation:** (B) if mainnet is on the near roadmap (next quarter); (A) if mainnet is more than 6 months out.

2. **Publisher identity — Panmoni or pushflip?** The publisher PDA's display name shows on every listing. "Panmoni" leverages existing brand equity (yapbay, tokenstork share the publisher); "pushflip" is project-specific and clearer. Hybrid: publisher = "Panmoni", app = "pushflip". Recommended: the hybrid.

3. **Saga support — first-class or best-effort?** Saga + Seeker share the dApp Store; one listing reaches both. But Saga's older OS occasionally surfaces edge cases. Decide: do we test Phase 4 acceptance on Saga, declare Saga compat done, and move on; OR ship Seeker-only with a "Saga not officially supported" note. Recommended: first-class — the test cost is low and it doubles the addressable audience.

4. **Hardware budget.** Will the project buy a Seeker for testing? At $450 it's not trivial. Alternative: borrow from Panmoni's existing devices, use the Solana Mobile developer device program, or rely on Saga + emulator for Phase 4 and buy a Seeker only post-launch for ongoing QA.

5. **Push notifications now or later?** Wiring Web Push at TWA time (~1 day) lets the listing advertise "round-start alerts." Doing it post-launch means a dead asset on the listing's feature list. Recommended: skip for v1, plan for v1.1 alongside Pre-Mainnet 5.0.9 PR 2.

---

## Reference: deploy-day checklist

Once Phases 0–3 are complete and Open Question #1 is resolved, Phase 4 is a one-session push:

- [ ] Publisher keypair generated, funded ~0.5 SOL, backed up to two locations.
- [ ] Storage backend account funded (ShdwDrive ~0.1 SOL, or Filebase API key).
- [ ] AAB built via Bubblewrap, signed with the upload key, version code = 1, version name = "0.1.0-mainnet" (or "-devnet").
- [ ] `dapp-store/config.yaml` filled with metadata; `dapp-store/assets/` populated with feature graphic + ≥4 screenshots + icon + (optional) video.
- [ ] `assetlinks.json` deployed to `play.pushflip.xyz/.well-known/assetlinks.json` via the `server-config` repo nginx diff. Verify with Google's Statement List Tester.
- [ ] `npx dapp-store create publisher` → publisher PDA created on-chain.
- [ ] `npx dapp-store create app` → app PDA created on-chain.
- [ ] `npx dapp-store create release` → AAB uploaded to ShdwDrive, release PDA created.
- [ ] `npx dapp-store publish submit` → moderation queue.
- [ ] Wait for moderation outcome (1–14 days). If rejected: iterate AAB or metadata, resubmit.
- [ ] On approval: real Seeker / Saga acceptance test (faucet → mint → join → play → payout).
- [ ] Announce listing on X/Twitter + Solana Mobile's Discord.

---

## Cross-references

- [EXECUTION_PLAN.md](EXECUTION_PLAN.md) — Phase 5 lists Seeker as a deferred item; this doc is the expansion of that line.
- [DEPLOYMENT_PLAN.md](DEPLOYMENT_PLAN.md) — pattern this doc follows; the dealer deploy story (Phase 4 / Pre-Mainnet 5.2) is a prerequisite (#3 above).
- [docs/wiki/operations/dealer-runbook.md](wiki/operations/dealer-runbook.md) — the keypair-custody pattern this plan inherits for the publisher keypair.
