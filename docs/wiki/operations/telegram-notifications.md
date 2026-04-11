---
title: Telegram Notifications
diataxis_type: how-to
last_compiled: 2026-04-11
---

# Telegram Commit Notifications

This repo posts a message to a Telegram group every time someone pushes commits to `main`. The goal is collaborator coordination — so anyone working on [pushflip](https://github.com/Panmoni/pushflip) can see at a glance what just landed without manually polling GitHub.

The whole thing is **one self-owned GitHub Actions workflow** ([.github/workflows/telegram-notify.yml](../../../.github/workflows/telegram-notify.yml)) that calls the Telegram Bot API directly. No third-party SaaS, no self-hosted webhook receiver, no polling. Free for public repos.

---

## How it works

```
git push (any contributor)
  └─ GitHub receives push event
      └─ .github/workflows/telegram-notify.yml triggered
          └─ Single Ubuntu runner, single step (~20–40 s end-to-end)
              └─ curl POST → api.telegram.org/bot<TOKEN>/sendMessage
                  └─ Telegram delivers message to the group
```

- **Trigger**: `push` events on the `main` branch only. WIP feature branches stay quiet.
- **Granularity**: one Telegram message per push. A push containing 5 commits produces 1 message with 5 bullets, not 5 separate messages.
- **Truncation**: pushes with >5 commits show the first 3 + `... and N more`.
- **Format**: HTML parse mode (only `<`, `>`, `&` are special). Avoids the MarkdownV2 special-character footgun where `_*[]()` would crash the request.
- **Failure mode**: if Telegram rejects the payload (`.ok != true`), the workflow run goes **red**. A "successful" curl with a silently dropped message would be the worst outcome — see [Why we fail loudly](#why-we-fail-loudly).

### Example message

```
🟢 George pushed 2 commits to main

• feat(app): wire wallet adapter (a3f9c1d)
• chore: bump kit to 6.0.2 (b8e7d04)

→ View diff
```

(`View diff` links to the GitHub `compare` URL for the push.)

---

## Setup (one-time)

You only need to do this once per repo. Both contributors share the same bot.

### 1. Create the Telegram bot

1. Open Telegram, DM [@BotFather](https://t.me/BotFather), send `/newbot`
2. Choose a display name (e.g., `pushflip commits`) and a username ending in `bot`
3. Copy the HTTP API token BotFather returns — this becomes `TELEGRAM_BOT_TOKEN`
4. Add the new bot to the existing collaborator group
5. Send any message in the group (so the bot has a recent update to fetch)
6. Run:
   ```
   curl https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
   and copy the `chat.id`. For groups it will be a **negative** number (e.g., `-1001234567890`). This becomes `TELEGRAM_CHAT_ID`.

### 2. Push the secrets to GitHub

Two GitHub Actions secrets are required:

| Secret | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | The HTTP API token from BotFather |
| `TELEGRAM_CHAT_ID` | The group chat ID (negative integer) |

Set them via the GitHub UI (`Settings → Secrets and variables → Actions`), or via the `gh` CLI from a local `.env` file:

```
# .env (gitignored — never commit this)
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=-1001234567890

gh secret set -f .env
gh secret list   # confirm both are present
```

`.env` is already covered by the `.env*` rule in [.gitignore](../../../.gitignore). Do not commit it.

### 3. Add collaborators to the repo

GitHub UI: `Settings → Collaborators and teams → Add people`. The notification workflow itself fires regardless of whether the pusher is a collaborator, but obviously they need push access for it to trigger at all.

---

## Verification

After setup, push a trivial commit to `main` and watch:

1. The workflow run on https://github.com/Panmoni/pushflip/actions — should go green within ~30 s
2. A message in the Telegram group within ~60 s of the push
3. The message shows the correct author, branch, commit count, subjects, and a working diff link

For a more thorough test, stack two local commits and push them together — the message should show both bullets in one notification, not two separate messages.

---

## Why we fail loudly

The most insidious failure mode is "GitHub Actions run is green, Telegram message never arrives." This happens when the curl returns 200 OK but Telegram's API responds with `{"ok": false, "description": "..."}` — typically because of a parse-mode escaping bug or a wrong chat ID.

The workflow guards against this with:

```bash
printf '%s\n' "$RESPONSE" | jq -e '.ok == true' > /dev/null
```

If `.ok` is anything other than `true`, `jq -e` exits non-zero and the Actions run goes **red**. The full Telegram response is also printed in the log so you can read the error description. Better to see a red run than to silently miss notifications and not realize until somebody asks "did you see my push?"

---

## Customization

All the things you'd want to tweak live in [.github/workflows/telegram-notify.yml](../../../.github/workflows/telegram-notify.yml).

| You want to... | Edit... |
|---|---|
| Notify on more branches | `on.push.branches:` list |
| Notify on tags / releases | Add `on.release` or `on.push.tags` |
| Send one message per commit instead of per push | Replace the `if [ "$COUNT" -le 5 ]` block with a `for` loop over `${{ github.event.commits }}` and call sendMessage once per iteration |
| Skip notifications via commit message tag | Add a `grep -q '\[skip notify\]'` early-exit on the head commit message |
| Truncate at a different commit count | Change the `5` and `3` literals in the truncation block |
| Include diff stats (files / lines changed) | Add a `actions/checkout@v4` step and shell out to `git diff --shortstat ${{ github.event.before }}..${{ github.event.after }}` |
| Change the message format | Edit the `printf '🟢 <b>%s</b> ...'` line — keep HTML escapes intact |

---

## Security notes

- **Bot token** is a GitHub Actions secret. GitHub auto-redacts registered secrets from the run logs, so even though the URL contains `${TELEGRAM_BOT_TOKEN}`, it appears as `***` in the log viewer.
- **Never echo the token** in the workflow (e.g., `echo $TELEGRAM_BOT_TOKEN` would still be redacted, but don't tempt fate).
- **Bot scope**: a Telegram bot token only grants control of that specific bot. If leaked, an attacker can spam the group, but cannot read DMs, leave the group, or pivot to other chats. Rotate via BotFather (`/revoke`) if leaked.
- **Workflow auditability**: the entire notification system is one YAML file in the repo. Anyone with read access can see exactly what gets sent. No third party receives commit messages.
- **`.env` handling**: the local `.env` exists only to make `gh secret set -f` ergonomic. It is gitignored and protected by the [block-dangerous.sh](../../../.claude/hooks/block-dangerous.sh) hook so AI tools cannot accidentally read or write it.

---

## Why this approach (vs. third-party bots)

A common alternative is a SaaS Telegram bot like [Notifine](https://t.me/gitlab_notifine_bot) — `/subscribe Panmoni/pushflip` and you're done. We rejected this because:

1. **Trust**: every webhook payload (commit message, author email, branch name) flows through a third party we don't control. Commit messages can contain sensitive context.
2. **Lifecycle**: SaaS bots can disappear, change pricing, or get rate-limited. A workflow file in our own repo cannot.
3. **Customization**: we own the message format end-to-end. Adding a `[skip notify]` opt-in or a diff-stat field is one YAML edit.
4. **Cost**: free for public repos on GitHub Actions.

Self-hosted alternatives (Docker polling bots, Go binaries with cron) were rejected as overkill — they require infrastructure for what is fundamentally a 40-line YAML file.

---

## Related docs

- [CLAUDE_HOOKS.md](claude-hooks.md) — the safety hooks that protect `.env` from accidental reads/writes
- [EXECUTION_PLAN.md](../../EXECUTION_PLAN.md) — broader project roadmap and phasing
