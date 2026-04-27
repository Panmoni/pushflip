/**
 * Deterministic-probe nickname assignment.
 *
 * Given a base58 wallet address, returns a globally-unique nickname
 * by walking a hash-derived probe sequence against the SQLite
 * registry. Idempotent: calling twice for the same address returns
 * the same answer (the second call is a fast SELECT cache-hit).
 *
 * Algorithm (matches `NICKNAME_ALGORITHM_VERSION = 1` in db.ts):
 *
 *   seed = SHA-256(pubkey-bytes-decoded-from-base58)
 *   for probe i = 0, 1, 2, …:
 *     // SHA-256(seed || u32le(i)) gives 32 bytes; we use 2 bytes per
 *     // candidate, so each hash gives us 16 candidates. probe_i picks
 *     // bytes [2i mod 32 .. 2i mod 32 + 1] from the (i div 16)-th
 *     // derivation block.
 *     adj = ADJECTIVES[derive_block[(2i) % 32]]
 *     noun = NOUNS[derive_block[(2i + 1) % 32]]
 *     candidate = `${adj}-${noun}`
 *     try INSERT INTO nicknames(address, nickname, ...) VALUES (?, ?, ...)
 *       on success: return candidate
 *       on UNIQUE constraint violation on `nickname`: continue
 *
 *   After PROBE_BARE_LIMIT bare candidates, switch to numeric suffixes:
 *     candidate = `${adj}-${noun}-${suffix}`  with suffix = 2, 3, 4, …
 *
 * Why a deterministic seed even though the registry is authoritative:
 *   - **Auditability**: anyone with the address can replay the probe
 *     sequence offline and verify the registered nickname is the first
 *     free candidate at the moment of registration.
 *   - **Stability across re-runs of `assignNickname` for the same
 *     address**: a SELECT-first cache check catches this before we
 *     even hit the probe loop (idempotency).
 *
 * Concurrency:
 *   - Two distinct addresses targeting the same first-choice nickname
 *     race against SQLite's UNIQUE constraint. The loser catches
 *     `SQLITE_CONSTRAINT_UNIQUE`, advances the probe, and tries the
 *     next candidate.
 *   - Two concurrent registrations for the *same* address are blocked
 *     upstream by the existing `pendingClaims` Set in `rate-limit.ts`
 *     (one of them wins the SELECT-first cache check before the
 *     other reaches the probe).
 */

import { createHash } from "node:crypto";

import { type Address, getAddressEncoder } from "@solana/kit";

import { NICKNAME_ALGORITHM_VERSION, type NicknameDb } from "./db";
import { ADJECTIVES, NOUNS } from "./words";

const addressEncoder = getAddressEncoder();

/**
 * Default cap on bare `${adj}-${noun}` probes before we start appending
 * numeric suffixes. With 256 × 256 = 65,536 bare combinations, hitting
 * this cap means the registry is essentially full of bare names —
 * astronomically unlikely until > 65K users. The cap is a safety net,
 * not a working budget; in normal operation a single-digit number of
 * probes is the worst case.
 */
export const DEFAULT_PROBE_BARE_LIMIT = 65_536;

/**
 * Default cap on the maximum numeric suffix attempted in Phase B. The
 * suffix walks 2..MAX inclusive, so at this default the loop attempts
 * 4,999 candidates after exhausting the bare phase. Total ceiling:
 * 65,536 + 4,999 = 70,535 probes before `assignNickname` throws. This
 * path is never expected in practice; the bound exists only so the
 * loop can't livelock on a thoroughly pathological registry.
 */
export const DEFAULT_PROBE_SUFFIX_MAX = 5000;

export interface ProbeLimits {
  bareLimit: number;
  suffixMax: number;
}

const DEFAULT_LIMITS: ProbeLimits = {
  bareLimit: DEFAULT_PROBE_BARE_LIMIT,
  suffixMax: DEFAULT_PROBE_SUFFIX_MAX,
};

/**
 * Decode a base58 pubkey to its 32-byte representation. Hashing the
 * raw bytes (not the base58 string) is what makes the seed
 * canonical — two clients that disagree on base58 case or
 * leading-zero handling can never produce different hashes for the
 * same wallet.
 *
 * Accepts the branded `Address` type to keep the validation contract
 * at the type level: the route handler validates via `parseRecipient`,
 * which is the only path that produces an `Address` value.
 */
function pubkeyBytes(address: Address): Uint8Array {
  return new Uint8Array(addressEncoder.encode(address));
}

/**
 * SHA-256 the inputs concatenated. Returns a 32-byte buffer.
 */
function sha256(...parts: Uint8Array[]): Uint8Array {
  const hash = createHash("sha256");
  for (const p of parts) {
    hash.update(p);
  }
  return new Uint8Array(hash.digest());
}

/**
 * Encode a non-negative integer as 4 little-endian bytes. Used to
 * domain-separate each derivation block in the probe sequence so
 * `SHA-256(seed || 0)` and `SHA-256(seed || 1)` are independent.
 */
function u32le(n: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, n, true);
  return buf;
}

/**
 * Compute the i-th candidate `${adjective}-${noun}` pair for the given
 * seed. Pure function; exposed for tests so they can pin
 * known-input → known-output without going through the DB.
 */
export function probeCandidate(seed: Uint8Array, i: number): string {
  const blockIndex = Math.floor(i / 16);
  const byteOffset = (i % 16) * 2;
  const block = sha256(seed, u32le(blockIndex));
  // Indexes from a single byte each (lists are 256 = 2^8, so no
  // modulo bias). `block[…]` cannot be undefined here because block is
  // exactly 32 bytes and offsets are bounded by the (i % 16) * 2
  // formula → max 30. The defensive throw is unreachable in practice
  // and exists only so we don't ship `!` non-null assertions.
  const adjIdx = block[byteOffset];
  const nounIdx = block[byteOffset + 1];
  if (adjIdx === undefined || nounIdx === undefined) {
    throw new Error(
      `probeCandidate: unreachable byte read at offset ${byteOffset}`
    );
  }
  return `${ADJECTIVES[adjIdx]}-${NOUNS[nounIdx]}`;
}

/**
 * Given a base58 address, derive the seed used for that address's
 * probe sequence. Pure function; exposed for tests + auditing.
 */
export function seedForAddress(address: Address): Uint8Array {
  return sha256(pubkeyBytes(address));
}

/**
 * Assign a unique nickname to `address`, persisting the result in
 * `db`. Idempotent: if a row already exists for this address, the
 * stored nickname is returned without entering the probe loop.
 *
 * Concurrency story (load-bearing): better-sqlite3 is fully synchronous
 * and Node's event loop is single-threaded, so a SELECT-then-INSERT
 * sequence inside a single HTTP handler runs to completion before any
 * other handler executes. Concurrent requests for distinct addresses
 * targeting the same first-choice nickname race against SQLite's
 * UNIQUE constraint, not against an application-level mutex; the
 * loser catches `SQLITE_CONSTRAINT_UNIQUE`, advances the probe, and
 * tries the next candidate. Concurrent requests for the *same*
 * address resolve via the post-conflict re-fetch (the winner's row is
 * always visible because better-sqlite3's INSERT has fully returned
 * before the loser's handler resumes).
 *
 * Throws if the probe hard limit is hit (registry is essentially
 * full — never expected in practice).
 *
 * `limits` is exposed for tests so they can exercise the suffix-phase
 * fallback without registering 65K addresses. Production callers
 * should always use the default.
 */
export function assignNickname(
  db: NicknameDb,
  address: Address,
  limits: ProbeLimits = DEFAULT_LIMITS
): { nickname: string; assigned: boolean } {
  // Idempotency fast path — return the stored row if any. Avoids the
  // probe loop entirely for the common "frontend asks for the same
  // address again" case (every <DisplayName> render after a cold load
  // hits this path through React Query's cache, but we still want the
  // server-side fast path for the rare un-cached fetch).
  const existing = db
    .prepare<[string], { nickname: string }>(
      "SELECT nickname FROM nicknames WHERE address = ?"
    )
    .get(address);
  if (existing) {
    return { nickname: existing.nickname, assigned: false };
  }

  const seed = seedForAddress(address);
  const insertStmt = db.prepare<[string, string, number, number]>(
    "INSERT INTO nicknames (address, nickname, algorithm, assigned_at) VALUES (?, ?, ?, ?)"
  );

  const tryInsert = (nickname: string): boolean => {
    try {
      insertStmt.run(address, nickname, NICKNAME_ALGORITHM_VERSION, Date.now());
      return true;
    } catch (e) {
      // SqliteError shape: { code: 'SQLITE_CONSTRAINT_UNIQUE', ... }.
      // Two cases collide on the SAME constraint code:
      //   - UNIQUE on nickname: another address took this name; advance probe.
      //   - PRIMARY KEY on address: this address was registered concurrently
      //     between our SELECT and our INSERT. Re-fetch and return the
      //     winner's row (the request that lost the race surfaces the
      //     winner's nickname, not an error).
      if (
        e instanceof Error &&
        "code" in e &&
        (e as { code: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
      ) {
        return false;
      }
      throw e;
    }
  };

  // Phase A: bare adjective-noun probes.
  for (let i = 0; i < limits.bareLimit; i++) {
    const candidate = probeCandidate(seed, i);
    if (tryInsert(candidate)) {
      return { nickname: candidate, assigned: true };
    }
    // INSERT failed. Re-check whether OUR address now has a row — if so,
    // it was a concurrent registration of the same address, return that
    // row (idempotency restored).
    const concurrent = db
      .prepare<[string], { nickname: string }>(
        "SELECT nickname FROM nicknames WHERE address = ?"
      )
      .get(address);
    if (concurrent) {
      return { nickname: concurrent.nickname, assigned: false };
    }
    // Otherwise the conflict was on the `nickname` column — advance.
  }

  // Phase B: numeric suffixes. Walk suffix = 2..suffixMax inclusive,
  // appending to probe 0's bare candidate. Astronomically unlikely
  // path in production; tests exercise it via shrunk limits.
  const baseCandidate = probeCandidate(seed, 0);
  for (let suffix = 2; suffix <= limits.suffixMax; suffix++) {
    const candidate = `${baseCandidate}-${suffix}`;
    if (tryInsert(candidate)) {
      return { nickname: candidate, assigned: true };
    }
  }

  const totalProbes = limits.bareLimit + (limits.suffixMax - 1);
  throw new Error(
    `nickname assignment exhausted ${totalProbes} probes for address ${address} — registry is unexpectedly full.`
  );
}
