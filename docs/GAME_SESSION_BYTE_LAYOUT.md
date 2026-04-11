# GameSession Account — Byte Layout Reference

This is a worked example of how to decode a raw `GameSession` account from
devnet. It is the on-chain layout produced by `program/src/state/game_session.rs`
and consumed by [clients/js/src/accounts/game-session.ts](../clients/js/src/accounts/game-session.ts) — the two MUST stay in sync byte-for-byte.

If you change the on-chain struct, you must also update the deserializer in
`clients/js/src/accounts/game-session.ts` and re-walk this table.

## How to dump an account yourself

```bash
# Pick any GameSession PDA — for game_id=1 on devnet it's:
solana account Hk6RLHBZ8oppV4KtQFFRsHC21z9tCL5HYz3cLELEA64A --url devnet
```

The PDA is derived from `[b"game", &game_id.to_le_bytes()]`. To recompute it
in TypeScript: `await deriveGamePda(1n)` from `@pushflip/client`.

## Worked example: a freshly-initialized game

The dump below is from `game_id=1` on devnet immediately after running
`pnpm --filter @pushflip/scripts init-game` (no players have joined, no deck
committed, all four authority slots filled with the same wallet for
simplicity):

```
Public Key: Hk6RLHBZ8oppV4KtQFFRsHC21z9tCL5HYz3cLELEA64A
Balance: 0.0044544 SOL
Owner: HQLeAQc84WLz8buHM5JAJGBjNJjwc6Fpxts8jSMaW3px
Length: 512 (0x200) bytes

0000:   01 fe 01 00  00 00 00 00  00 00 25 89  1d 97 2d c9   ..........%...-.
0010:   2a 40 a1 f3  8d 27 17 f7  73 69 a7 23  a6 23 e3 6c   *@...'..si.#.#.l
0020:   09 97 92 a6  28 0c 6c 7f  2e ad 25 89  1d 97 2d c9   ....(.l...%...-.
0030:   2a 40 a1 f3  8d 27 17 f7  73 69 a7 23  a6 23 e3 6c   *@...'..si.#.#.l
0040:   09 97 92 a6  28 0c 6c 7f  2e ad 25 89  1d 97 2d c9   ....(.l...%...-.
0050:   2a 40 a1 f3  8d 27 17 f7  73 69 a7 23  a6 23 e3 6c   *@...'..si.#.#.l
0060:   09 97 92 a6  28 0c 6c 7f  2e ad 25 89  1d 97 2d c9   ....(.l...%...-.
0070:   2a 40 a1 f3  8d 27 17 f7  73 69 a7 23  a6 23 e3 6c   *@...'..si.#.#.l
0080:   09 97 92 a6  28 0c 6c 7f  2e ad 13 af  5a bb 00 ba   ....(.l.....Z...
0090:   9d 98 35 d0  57 45 6d d8  b8 d5 21 81  b0 20 e9 e4   ..5.WEm...!.. ..
00a0:   ee 54 8f b4  14 98 68 78  9c 82 35 55  31 8d 89 2c   .T....hx..5U1..,
00b0:   8e 28 d9 9d  6c 3d 02 ef  6b 7e 61 4e  6d 94 52 bd   .(..l=..k~aNm.R.
00c0:   bf 54 99 03  49 8f f6 3c  2c c6 00 00  00 00 00 00   .T..I..<,.......
00d0:   00 00 00 00  00 00 00 00  00 00 00 00  00 00 00 00   ................
00e0:   00 00 00 00  00 00 00 00  00 00 00 00  00 00 00 00   ................
00f0:   00 00 00 00  00 00 00 00  00 00 00 00  00 00 00 00   ................
0100:   00 00 00 00  00 00 00 00  00 00 00 00  00 00 00 00   ................
0110:   00 00 00 00  00 00 00 00  00 00 00 00  00 00 00 00   ................
0120:   00 00 00 00  00 00 00 00  00 00 00 00  00 00 00 00   ................
0130:   00 00 00 00  00 00 00 00  00 00 00 00  00 00 00 00   ................
0140:   00 00 00 00  00 00 00 00  00 00 00 00  00 00 00 00   ................
0150:   00 00 00 00  00 00 00 00  00 00 00 00  00 00 00 00   ................
0160:   00 00 00 00  00 00 00 00  00 00 00 00  00 00 00 00   ................
0170:   00 00 00 00  00 00 00 00  00 00 00 00  00 00 00 c8   ................
0180:   00 00 00 00  00 00 00 00  00 00 ff 00  00 00 00 00   ................
0190:   00 00 00 00  00 00 00 00  00 00 00 00  00 00 00 00   ................
01a0:   00 00 00 00  00 00 00 00  00 00 00 00  00 00 00 00   ................
01b0:   00 00 00 00  00 00 00 00  00 00 00 00  00 00 00 00   ................
01c0:   00 00 00 00  00 00 00 00  00 00 00 00  00 00 00 00   ................
01d0:   00 00 00 00  00 00 00 00  00 00 00 00  00 00 00 00   ................
01e0:   00 00 00 00  00 00 00 00  00 00 00 00  00 00 00 00   ................
01f0:   00 00 00 00  00 00 00 00  00 00 00 00  00 00 00 00   ................
```

## Field-by-field decoding table

| Offset (hex) | Offset (dec) | Size | Field | Type | Bytes (this dump) | Decoded value |
|---|---|---|---|---|---|---|
| `0x00` | 0 | 1 | `discriminator` | u8 | `01` | `1` = GameSession (matches `GAME_SESSION_DISCRIMINATOR`) |
| `0x01` | 1 | 1 | `bump` | u8 | `fe` | `254` |
| `0x02` | 2 | 8 | `gameId` | u64 LE | `01 00 00 00 00 00 00 00` | `1` |
| `0x0a` | 10 | 32 | `authority` | Pubkey | `25 89 1d 97 2d c9 2a 40 a1 f3 8d 27 17 f7 73 69 a7 23 a6 23 e3 6c 09 97 92 a6 28 0c 6c 7f 2e ad` | `3XXMLDEf2DDdmgR978U8T5GhFLnxDNDUcJ2ETDw2bUWp` |
| `0x2a` | 42 | 32 | `house` | Pubkey | (same as authority) | same wallet |
| `0x4a` | 74 | 32 | `dealer` | Pubkey | (same) | same wallet |
| `0x6a` | 106 | 32 | `treasury` | Pubkey | (same) | same wallet |
| `0x8a` | 138 | 32 | `tokenMint` | Pubkey | `13 af 5a bb 00 ba 9d 98 35 d0 57 45 6d d8 b8 d5 21 81 b0 20 e9 e4 ee 54 8f b4 14 98 68 78 9c 82` | `2KqqB7SRVaD98ZbVaiRWirxbaJv5ryNzkDRGweBZVryF` (TEST_FLIP_MINT) |
| `0xaa` | 170 | 32 | `vault` | Pubkey | `35 55 31 8d 89 2c 8e 28 d9 9d 6c 3d 02 ef 6b 7e 61 4e 6d 94 52 bd bf 54 99 03 49 8f f6 3c 2c c6` | `4bBxJvNdkfqo6cMoodS5c8nNyzBeWFb3uJiY9aRTicW1` (vault PDA, derived from `[b"vault", game_pda.as_ref()]`) |
| `0xca` | 202 | 1 | `playerCount` | u8 | `00` | `0` |
| `0xcb` | 203 | 128 | `turnOrder` | `[Pubkey; 4]` | 128 bytes of `00` | empty — no players |
| `0x14b` | 331 | 1 | `currentTurnIndex` | u8 | `00` | `0` |
| `0x14c` | 332 | 1 | `roundActive` | bool | `00` | `false` |
| `0x14d` | 333 | 8 | `roundNumber` | u64 LE | `00 00 00 00 00 00 00 00` | `0` |
| `0x155` | 341 | 8 | `potAmount` | u64 LE | `00 00 00 00 00 00 00 00` | `0` |
| `0x15d` | 349 | 32 | `merkleRoot` | `[u8; 32]` | 32 bytes of `00` | empty (no deck committed) |
| `0x17d` | 381 | 1 | `deckCommitted` | bool | `00` | `false` |
| `0x17e` | 382 | 1 | `drawCounter` | u8 | `00` | `0` |
| `0x17f` | 383 | 2 | `treasuryFeeBps` | u16 LE | `c8 00` | `0x00c8` = `200` (= 2%) |
| `0x181` | 385 | 1 | `rolloverCount` | u8 | `00` | `0` |
| `0x182` | 386 | 8 | `lastActionSlot` | u64 LE | `00 00 00 00 00 00 00 00` | `0` |
| `0x18a` | 394 | 1 | `vaultBump` | u8 | `ff` | `255` |
| `0x18b` – `0x1ff` | 395 – 511 | 117 | **padding** | — | all `00` | over-allocation, see note below |

**Total used: 395 bytes. Total allocated: 512 bytes.**

## Key observations

### The four identical 32-byte runs from `0x0a` to `0x89`

In this particular dump, all four authority slots (`authority`, `house`,
`dealer`, `treasury`) hold the same wallet pubkey because `init-game.ts`
fills every slot with the same CLI keypair for simplicity. In a real
production game these would be **different** keys:

- `authority` — governance / admin actions like `start_round`, `end_round`
- `house` — the AI opponent's identity (Phase 4)
- `dealer` — the off-chain ZK shuffle service signer (only key that signs `commit_deck`)
- `treasury` — the address that receives the 2% rake on each pot

### vault_ready is NOT stored on the account

There is no `vaultReady` field in the GameSession struct. The program
determines `vault_ready` at runtime by checking whether an SPL token
account exists at the `vault` PDA address. For a freshly-initialized
game with no token account at the vault PDA, `vault_ready` resolves to
false and `join_round` validates `MIN_STAKE` but skips the actual
token transfer.

### Account length is 512 bytes but the struct only uses 395

The remaining 117 bytes (`0x18b` onwards) are zero padding from
over-allocation. This is the same "oversized program data slot" tracked
as **Task 5.0.1** in the pre-mainnet checklist
(see [EXECUTION_PLAN.md](EXECUTION_PLAN.md) → `### Pre-Mainnet Checklist`).
The on-chain account costs slightly more rent than necessary; reclaiming
the extra 117 bytes saves ~0.0008 SOL per game session.

### Owner = the pushflip program ID

`HQLeAQc84WLz8buHM5JAJGBjNJjwc6Fpxts8jSMaW3px` is the pushflip program ID.
Solana enforces that **only the owning program can write** to an account's
data, which is what makes the PDA-stored state trustworthy. Anyone can
read this account, but only a pushflip instruction with the correct
authority signer can mutate it.

### Balance: 0.0044544 SOL

This is the rent-exempt minimum for a 512-byte account on devnet. Initialize
is **not a true cost** — it's a refundable deposit. When `closeGame` is
eventually called against this account, that exact amount returns to the
designated rent recipient.

## How to reproduce this dump

```bash
# 1. Initialize the game (idempotent)
pnpm --filter @pushflip/scripts init-game

# 2. Dump the raw account
solana account Hk6RLHBZ8oppV4KtQFFRsHC21z9tCL5HYz3cLELEA64A --url devnet
```

If the layout has changed since this document was written, decode the
fields in declaration order using
[clients/js/src/accounts/game-session.ts](../clients/js/src/accounts/game-session.ts)
as the source of truth — the order of `r.u8()`, `r.u64()`, `r.pubkey()`,
etc. inside `decodeGameSession` is the byte layout.

## Related files

- [program/src/state/game_session.rs](../program/src/state/game_session.rs) — on-chain Rust definition
- [clients/js/src/accounts/game-session.ts](../clients/js/src/accounts/game-session.ts) — TypeScript deserializer
- [clients/js/src/pda.ts](../clients/js/src/pda.ts) — PDA derivation (`deriveGamePda`, `deriveVaultPda`)
- [scripts/init-game.ts](../scripts/init-game.ts) — the script that produced the worked example above
