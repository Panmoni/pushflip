export { Dealer, type DealerConfig, type CardReveal } from "./dealer.js";
export {
  type Card,
  createCanonicalDeck,
  fisherYatesShuffle,
  applyPermutation,
  DECK_SIZE,
  NUM_LEAVES,
  TREE_DEPTH,
  ALPHA,
  PROTOCOL,
  MULTIPLIER,
} from "./deck.js";
export {
  buildMerkleTree,
  getMerkleProof,
  computeCanonicalHash,
  hashCardLeaf,
  bigintToBytes32BE,
  bytes32BEToBigint,
  type MerkleTree,
} from "./merkle.js";
export {
  generateProof,
  verifyProofLocally,
  packCommitDeckData,
  type SerializedProof,
  type ProofGenerationResult,
} from "./prover.js";
