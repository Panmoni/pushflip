---
title: Podman rootless network traps
diataxis_type: explanation
last_compiled: 2026-04-28
related_wiki:
  - operations/index.md
  - operations/hosting-and-rpc.md
  - history/index.md
---

# Podman rootless network traps

Why the `pushflip-vite` and `pushflip-faucet` Dockerfiles pass `--network=host` to `podman build`, what happened the day they didn't, and how to recognise the same trap in any future container build.

This page is the institutional memory for the 2026-04-27/28 deploy saga that burned ~7 hours debugging eight failed `npm install` runs in a row before the actual cause was found in podman's network layer. Everything in [Lesson #54-#56 of EXECUTION_PLAN.md](../history/index.md) lives here in narrative form.

## TL;DR

- **Symptom**: `npm install` hangs partway through downloads, eventually fails with `npm error code EIDLETIMEOUT — Idle timeout reached for host registry.npmjs.org:443`. (Or in earlier toolchains: `pnpm install` deadlocks at ~733 of 734 packages with `Sl` state on every thread.)
- **Cause**: Podman's default rootless networking stack (netavark) mangles long-lived TCP keep-alives in a way that breaks npm's HTTP-agent connection pool. Sockets idle out at ~60s when they shouldn't.
- **Fix**: `podman build --network=host` for the build phase. Runtime services already use `Network=host` per their quadlets, which is why only **build** containers were affected.
- **Diagnostic that would have saved 7 hours**: `ssh tucker 'curl https://registry.npmjs.org/'` from the host. If that returns 200 in <1s but the build container can't reach it, the problem is the container's network namespace, not your tool config.

## The full failure mode

The bug surfaces differently in different package managers:

| Tool | Symptom | Reason |
|---|---|---|
| `pnpm install` (multi-threaded fetcher) | All threads in `S` (sleeping), 0 forward progress, ~20% CPU. Sometimes deadlocks at the same package count across runs (e.g., 733/734). | pnpm's libuv worker threads block on idle sockets that never come back. |
| `npm install` (single-threaded fetcher) | Hangs for ~60s after warning lines, then fails loud with `EIDLETIMEOUT — Idle timeout reached for host registry.npmjs.org:443`. | npm's `agentkeepalive`-backed HTTP agent drops idle sockets at 60s. CLI flags like `--fetch-timeout` and `--fetch-retries` configure individual fetches, not the underlying agent socket — they don't reach this layer. |

Both surface the same root cause: rootless container networking + long-lived TCP sockets to a remote registry.

What's misleading: the per-tool symptoms look so different that you'd debug them as if they're separate bugs. They aren't. Both Lesson #54 (pnpm@9 vs pnpm@10) and Lesson #55 (pnpm → npm migration) were workarounds for symptoms of this same root cause. They each "worked" for one deploy, but only because the smaller package set in that deploy was less likely to push any single TCP socket past the 60s idle threshold during install. The moment the package set grew — better-sqlite3 in 5.0.10 — the bug returned.

## Why runtime is unaffected

The runtime services (`pushflip-vite`, `pushflip-faucet`, the apex `pushflip` pod) already run with `Network=host` per their podman quadlets:

```ini
# ~/.config/containers/systemd/pushflip.pod
[Pod]
PodName=pushflip
Network=host
```

The pod-level `Network=host` makes containers in the pod share the host's network stack directly — no netavark, no NAT, no TCP keep-alive mangling. The runtime nginx-faucet, faucet-RPC, and faucet-Helius connections work fine because they bypass the broken layer.

The **build** containers, by contrast, were running through the default rootless network namespace. Same packages, same registry, same host — but routed through netavark instead of the host's stack.

## The fix

Two `podman build` invocations in `scripts/deploy-tucker.sh`, both pass `--network=host`:

```bash
podman build --network=host \
  -t localhost/pushflip-vite:latest \
  --build-arg VITE_FAUCET_URL=/api/faucet \
  ...
  -f app/Dockerfile .

podman build --network=host \
  -t localhost/pushflip-faucet:latest \
  -f faucet/Dockerfile .
```

That's it. One flag.

After the fix landed, `npm install` completed in **43s on the first try**, never engaged the retry loop, never timed out. Total deploy time fell from "8 hours and counting, all failed" to **2m 51s succeeding cleanly**.

## Diagnostic playbook

When a containerized network operation hangs or times out and the host's network is fine, run this in order:

1. **Test the connection from the host.** This is the 30-second check that should always come first:
   ```bash
   ssh <host> 'curl -sS -o /dev/null -w "%{http_code} time=%{time_total}s size=%{size_download}\n" https://<endpoint>'
   ```
   If the host returns 200 in <1s but the container can't, the problem is in the container's network namespace.

2. **Check what processes are doing.** A hung CPU-using process is different from an idle sleeping one:
   ```bash
   ssh <host> 'ps -p <pid> -o pid,etime,time,stat,wchan'
   ```
   `STAT=Sl` (or `Ssl`) + `wchan=ep_poll` + `TIME` not advancing across two samples = waiting on I/O that's not coming back. That's the signature of this bug.

3. **Check sockets.** Are there idle TLS connections to the remote endpoint?
   ```bash
   ssh <host> 'ss -tnp 2>/dev/null | grep :443 | head'
   ```
   If you see `ESTAB` connections that are sitting there at 0 bytes/s, those are the keep-alives that netavark is going to drop without telling anyone.

4. **Try `--network=host` as the trial fix.** If the operation is fundamentally a build-time fetch (no need for container network isolation), the host's network stack is fine — just use it.

## Why it's specifically podman rootless

The bug is in the interaction between:

- **netavark** (podman's default rootless network backend, replacing the older slirp4netns).
- **TCP keep-alive packet handling across the rootless NAT.**
- **Long-lived HTTP keep-alive sockets** that npm's HTTP agent maintains to the registry for connection reuse across many package downloads.

In rootful podman or with `--network=host`, the container shares the host's network stack and these issues don't manifest. The same applies to docker (which uses different networking primitives entirely — docker's bridge networking has its own issues but not this one).

If you ever migrate off podman or off rootless, this trap goes away — but `--network=host` for build is still a reasonable default because there's no security benefit to namespacing the network during a fetch-and-extract phase.

## Related lessons

This trap was reinforced by **three** stacked sagas in pushflip's history. Each one tried a different layer fix without dropping a layer to look:

- **Lesson #54** (5.0.7 deploy, 2026-04-26): pnpm@10 → pnpm@9 pin. Worked at the time but only because the package set was small.
- **Lesson #55** (5.0.10 deploy, 2026-04-27): pnpm → npm migration. ~80 lines of Dockerfile rewrite plus a `workspace:*` → `file:` rewrite step. Cleared the "EUNSUPPORTEDPROTOCOL" error but immediately revealed the same idle-timeout bug under a different name.
- **Lesson #56** (5.0.10 deploy, 2026-04-27/28): `--network=host`. The actual fix.

The unifying heuristic, recorded as the meta-lesson in EXECUTION_PLAN.md:

> **Three or more stacked workarounds across two or more tool changes ⇒ stop fixing the tool. The bug is in the layer below.**

Apply that early next time. Test from the host before re-tweaking the tool.

## Related

- [Hosting & RPC](hosting-and-rpc.md) — VPS sizing and RPC plan choices for the same deploy target.
- [Project History](../history/index.md) — Lessons #54, #55, #56 narrative.
- The deploy script that ships the fix: [`scripts/deploy-tucker.sh`](https://github.com/Panmoni/pushflip/blob/main/scripts/deploy-tucker.sh).
- Supporting Dockerfiles where `--ignore-scripts`, the `workspace:*` rewrite, and `--mount=type=cache,target=/root/.npm` survive as belt-and-suspenders: [`app/Dockerfile`](https://github.com/Panmoni/pushflip/blob/main/app/Dockerfile), [`faucet/Dockerfile`](https://github.com/Panmoni/pushflip/blob/main/faucet/Dockerfile).
