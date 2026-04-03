import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildMerkleTree,
  getMerkleProof,
  hashCardLeaf,
  computeCanonicalHash,
  bigintToBytes32BE,
  bytes32BEToBigint,
} from "./merkle.js";
import { createCanonicalDeck, applyPermutation, DECK_SIZE, NUM_LEAVES, TREE_DEPTH } from "./deck.js";

describe("hashCardLeaf", () => {
  it("is deterministic", async () => {
    const h1 = await hashCardLeaf(5, 0, 2, 0);
    const h2 = await hashCardLeaf(5, 0, 2, 0);
    assert.equal(h1, h2);
  });

  it("produces different hashes for different inputs", async () => {
    const h1 = await hashCardLeaf(5, 0, 2, 0);
    const h2 = await hashCardLeaf(6, 0, 2, 0);
    assert.notEqual(h1, h2);
  });
});

describe("canonicalHash", () => {
  it("matches the on-chain CANONICAL_DECK_HASH constant", async () => {
    const deck = createCanonicalDeck();
    const hash = await computeCanonicalHash(deck);
    const bytes = bigintToBytes32BE(hash);

    // This must match CANONICAL_DECK_HASH in program/src/zk/verifying_key.rs
    const expected = new Uint8Array([
      11, 204, 204, 236, 237, 116, 74, 11, 99, 195, 140, 133, 89, 130, 233, 205,
      43, 50, 81, 205, 237, 209, 209, 149, 0, 42, 79, 138, 91, 69, 188, 253,
    ]);

    assert.deepEqual(bytes, expected, "Dealer canonical hash must match on-chain constant");
  });
});

describe("buildMerkleTree", () => {
  it("builds tree with correct leaf count", async () => {
    const deck = createCanonicalDeck();
    const tree = await buildMerkleTree(deck);

    assert.equal(tree.leaves.length, NUM_LEAVES);
    assert.equal(tree.levels.length, TREE_DEPTH + 1); // leaves + 7 internal levels
    assert.equal(tree.levels[TREE_DEPTH].length, 1); // root level
  });

  it("produces non-zero root", async () => {
    const deck = createCanonicalDeck();
    const tree = await buildMerkleTree(deck);
    assert.notEqual(tree.root, 0n);
  });
});

describe("getMerkleProof", () => {
  it("returns TREE_DEPTH siblings", async () => {
    const deck = createCanonicalDeck();
    const tree = await buildMerkleTree(deck);
    const proof = getMerkleProof(tree, 0);
    assert.equal(proof.length, TREE_DEPTH);
  });

  it("rejects out-of-range index", async () => {
    const deck = createCanonicalDeck();
    const tree = await buildMerkleTree(deck);
    assert.throws(() => getMerkleProof(tree, NUM_LEAVES), /out of range/);
  });
});

describe("bigintToBytes32BE / bytes32BEToBigint", () => {
  it("round-trips correctly", () => {
    const val = 12345678901234567890n;
    const bytes = bigintToBytes32BE(val);
    const recovered = bytes32BEToBigint(bytes);
    assert.equal(recovered, val);
  });
});
