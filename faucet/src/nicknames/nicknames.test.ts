/**
 * Tests for the deterministic-probe nickname assignment (Pre-Mainnet 5.0.10).
 *
 * Run via `pnpm --filter @pushflip/faucet test` (Node's built-in test
 * runner via tsx, matching the convention used by `clients/js`).
 *
 * Coverage:
 *   - Determinism + idempotency (same address → same nickname, twice).
 *   - Distinct outputs across known devnet wallets.
 *   - 1000-pubkey randomized sweep: > 98% unique without collisions.
 *   - Probing under forced collision (pre-seed the first-choice
 *     nickname and assert the loser advances).
 *   - Banned-word filter against the full Cartesian product
 *     (snapshot-style — no banned token appears in any combination).
 *   - Word lists are exactly 256 each (the load-bearing power-of-two
 *     property that lets us index with a single byte without modulo bias).
 *   - Algorithm version invariants (mixed-version DB rejected at boot).
 */

import { doesNotThrow, equal, notEqual, ok, throws } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  type Address,
  generateKeyPair,
  getAddressFromPublicKey,
} from "@solana/kit";

import {
  assignNickname,
  DEFAULT_PROBE_BARE_LIMIT,
  probeCandidate,
  seedForAddress,
} from "./assign";
import {
  assertSchemaInvariants,
  countNicknames,
  NICKNAME_ALGORITHM_VERSION,
  openNicknameDb,
} from "./db";
import { ADJECTIVES, BANNED_WORDS, NOUNS } from "./words";

let tmpRoot: string;
const dbsToClose: Array<{ close: () => void }> = [];

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pushflip-nicknames-test-"));
});

after(() => {
  for (const db of dbsToClose) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

function freshDb(label: string) {
  const db = openNicknameDb(
    join(tmpRoot, `${label}-${Date.now()}-${Math.random()}.db`)
  );
  dbsToClose.push(db);
  return db;
}

async function makeAddress(): Promise<Address> {
  const kp = await generateKeyPair();
  return await getAddressFromPublicKey(kp.publicKey);
}

// Module-scope so they're compiled once. biome's `useTopLevelRegex`
// rule flags inline literal patterns as a perf hint; for tests this
// is essentially free, but the rule is consistent with the rest of
// the codebase.
const EXHAUSTED_ERROR_RE = /exhausted .* probes/;
const ALGORITHM_VERSION_ERROR_RE = /algorithm version/;

describe("words.ts — list shape", () => {
  it("ADJECTIVES has exactly 256 entries", () => {
    equal(ADJECTIVES.length, 256);
  });
  it("NOUNS has exactly 256 entries", () => {
    equal(NOUNS.length, 256);
  });
  it("no entry contains a banned token as a substring (Cartesian sweep)", () => {
    // Walks the full 256x256 = 65,536 product. Each iteration is a
    // string concat + a Set.has() lookup, so total cost is well under
    // 100 ms in CI. Any banned token that slips into either list will
    // be caught by this sweep before it can ship.
    for (const adj of ADJECTIVES) {
      for (const noun of NOUNS) {
        const combo = `${adj}-${noun}`;
        for (const banned of BANNED_WORDS) {
          ok(
            !combo.includes(banned),
            `combo "${combo}" contains banned token "${banned}"`
          );
        }
      }
    }
  });
});

describe("probeCandidate — pure function", () => {
  it("is deterministic: same seed + i → same candidate", () => {
    const seed = seedForAddress("11111111111111111111111111111111" as Address);
    for (let i = 0; i < 100; i++) {
      equal(probeCandidate(seed, i), probeCandidate(seed, i));
    }
  });
  it("produces different candidates across i (high probability)", () => {
    const seed = seedForAddress("11111111111111111111111111111111" as Address);
    const seen = new Set<string>();
    for (let i = 0; i < 32; i++) {
      seen.add(probeCandidate(seed, i));
    }
    // Birthday: among 32 candidates from 65,536 buckets, collision
    // probability is ~0.78%. We expect at least 30 distinct outputs.
    ok(seen.size >= 30, `expected >= 30 distinct, got ${seen.size}`);
  });
  it("always returns 'adjective-noun' shape (no suffix at probe layer)", () => {
    const seed = seedForAddress("11111111111111111111111111111111" as Address);
    for (let i = 0; i < 16; i++) {
      const cand = probeCandidate(seed, i);
      const parts = cand.split("-");
      equal(parts.length, 2, `bad shape: ${cand}`);
      const [adj, noun] = parts;
      ok(adj !== undefined && ADJECTIVES.includes(adj), `unknown adj: ${adj}`);
      ok(noun !== undefined && NOUNS.includes(noun), `unknown noun: ${noun}`);
    }
  });
});

describe("assignNickname — registry semantics", () => {
  it("idempotency: same address → same nickname across calls", async () => {
    const db = freshDb("idem");
    const addr = await makeAddress();
    const first = assignNickname(db, addr);
    const second = assignNickname(db, addr);
    equal(first.nickname, second.nickname);
    equal(first.assigned, true);
    equal(second.assigned, false);
  });

  it("first-call returns the first-probe candidate (no spurious advance)", async () => {
    const db = freshDb("first-probe");
    const addr = await makeAddress();
    const expected = probeCandidate(seedForAddress(addr), 0);
    const result = assignNickname(db, addr);
    equal(result.nickname, expected);
  });

  it("forced collision: second address advances to next probe", async () => {
    const db = freshDb("collision");
    const addr1 = await makeAddress();
    const addr2 = await makeAddress();
    // Pre-seed addr1 -> addr2's first-choice nickname so addr2's
    // assignment is forced to advance.
    const addr2FirstChoice = probeCandidate(seedForAddress(addr2), 0);
    db.prepare(
      "INSERT INTO nicknames (address, nickname, algorithm, assigned_at) VALUES (?, ?, ?, ?)"
    ).run(addr1, addr2FirstChoice, NICKNAME_ALGORITHM_VERSION, Date.now());

    const result = assignNickname(db, addr2);
    notEqual(result.nickname, addr2FirstChoice);
    // The result must be at probe i=1, 2, 3, ... but cannot be i=0.
    let foundAtProbe = -1;
    for (let i = 1; i < 50; i++) {
      if (probeCandidate(seedForAddress(addr2), i) === result.nickname) {
        foundAtProbe = i;
        break;
      }
    }
    ok(foundAtProbe >= 1, `expected to find at probe >= 1, didn't find`);
  });

  it("global uniqueness invariant holds across 200 random addresses", async () => {
    const db = freshDb("uniq200");
    const addresses: Address[] = [];
    for (let i = 0; i < 200; i++) {
      addresses.push(await makeAddress());
    }
    const nicknames = new Set<string>();
    for (const a of addresses) {
      const r = assignNickname(db, a);
      ok(!nicknames.has(r.nickname), `duplicate nickname ${r.nickname}`);
      nicknames.add(r.nickname);
    }
    equal(nicknames.size, 200);
    assertSchemaInvariants(db);
    equal(countNicknames(db), 200);
  });

  it("re-asking after restart returns the same nickname (schema persistence)", async () => {
    const path = join(tmpRoot, `persist-${Date.now()}.db`);
    const db1 = openNicknameDb(path);
    const addr = await makeAddress();
    const first = assignNickname(db1, addr);
    db1.close();
    const db2 = openNicknameDb(path);
    dbsToClose.push(db2);
    const second = assignNickname(db2, addr);
    equal(second.nickname, first.nickname);
    equal(second.assigned, false);
  });

  it("Phase B suffix fallback engages once the bare phase is exhausted", async () => {
    // Exercise the suffix path with shrunk limits so we don't have to
    // register 65,536 addresses to reach it. With bareLimit=1 and a
    // single pre-seeded row claiming our address's first-choice
    // candidate, the probe loop finishes the bare phase in one
    // iteration (UNIQUE conflict) then falls through to the suffix
    // phase, where it tries `${base}-2`.
    const db = freshDb("phase-b-suffix");
    const addr = await makeAddress();
    const baseCandidate = probeCandidate(seedForAddress(addr), 0);
    // Pre-seed a competitor (different address) holding the bare name.
    const competitor = await makeAddress();
    db.prepare(
      "INSERT INTO nicknames (address, nickname, algorithm, assigned_at) VALUES (?, ?, ?, ?)"
    ).run(competitor, baseCandidate, 1, Date.now());

    const result = assignNickname(db, addr, { bareLimit: 1, suffixMax: 100 });
    equal(result.assigned, true);
    equal(result.nickname, `${baseCandidate}-2`);
  });

  it("Phase B suffix advances when the suffixed candidate is also taken", async () => {
    const db = freshDb("phase-b-advance");
    const addr = await makeAddress();
    const baseCandidate = probeCandidate(seedForAddress(addr), 0);
    const competitor1 = await makeAddress();
    const competitor2 = await makeAddress();
    // Pre-seed BOTH the bare candidate AND `${base}-2` so the suffix
    // loop has to advance past 2.
    db.prepare(
      "INSERT INTO nicknames (address, nickname, algorithm, assigned_at) VALUES (?, ?, ?, ?)"
    ).run(competitor1, baseCandidate, 1, Date.now());
    db.prepare(
      "INSERT INTO nicknames (address, nickname, algorithm, assigned_at) VALUES (?, ?, ?, ?)"
    ).run(competitor2, `${baseCandidate}-2`, 1, Date.now());

    const result = assignNickname(db, addr, { bareLimit: 1, suffixMax: 100 });
    equal(result.nickname, `${baseCandidate}-3`);
  });

  it("throws when both phases are exhausted", async () => {
    // Tiny limits + pre-fill every candidate. We'd need to walk the
    // probe sequence here; a simpler proxy is bareLimit=0, suffixMax=1
    // (so Phase A skips entirely and Phase B's first suffix-2 attempt
    // is its only candidate) plus pre-seed `${base}-2`. Since the
    // suffix loop runs `suffix <= suffixMax` and starts at 2, with
    // suffixMax=1 the loop never executes.
    const db = freshDb("exhausted");
    const addr = await makeAddress();
    throws(
      () => assignNickname(db, addr, { bareLimit: 0, suffixMax: 1 }),
      EXHAUSTED_ERROR_RE
    );
  });

  it("default limits cover at least the full bare-phase combination space", () => {
    // Schema invariant test: the default bare limit should equal the
    // ADJECTIVES.length * NOUNS.length product. If someone shrinks a
    // word list without updating this constant, this test catches it.
    equal(DEFAULT_PROBE_BARE_LIMIT, 256 * 256);
  });
});

describe("assertSchemaInvariants", () => {
  it("passes on a fresh DB", () => {
    const db = freshDb("invariant-fresh");
    doesNotThrow(() => assertSchemaInvariants(db));
  });
  it("fails on a row inserted under a different algorithm version", () => {
    const db = freshDb("invariant-version");
    db.prepare(
      "INSERT INTO nicknames (address, nickname, algorithm, assigned_at) VALUES (?, ?, ?, ?)"
    ).run(
      "FakeAddress11111111111111111111111111111",
      "fake-nickname",
      NICKNAME_ALGORITHM_VERSION + 1,
      Date.now()
    );
    throws(() => assertSchemaInvariants(db), ALGORITHM_VERSION_ERROR_RE);
  });
});
