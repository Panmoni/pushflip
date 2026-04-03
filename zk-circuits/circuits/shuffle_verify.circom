pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/multiplexer.circom";

/// ShuffleVerify: Proves a shuffled deck is a valid permutation of the
/// canonical deck, and that the Poseidon Merkle tree over the shuffled
/// deck produces the given Merkle root.
///
/// Public inputs:
///   - merkle_root: root of the Poseidon Merkle tree over shuffled deck
///   - canonical_hash: hash of the canonical (unshuffled) deck
///
/// Private inputs:
///   - permutation[DECK_SIZE]: indices mapping canonical → shuffled positions
///     perm[i] = index of canonical card placed at shuffled position i
///   - canonical_values[DECK_SIZE]: card value for each canonical card
///   - canonical_types[DECK_SIZE]: card type for each canonical card
///   - canonical_suits[DECK_SIZE]: card suit for each canonical card

// Deck size: 94 cards (52 Alpha + 30 Protocol + 12 Multiplier)
// Tree depth: 7 (128 leaves, 94 used + 34 padding)

/// PermutationCheck: Verifies that perm[] is a valid bijection on [0, N-1].
///
/// Uses the grand product argument:
///   For a random challenge alpha (derived via Fiat-Shamir from permutation),
///   prod_{i=0}^{N-1} (alpha + perm[i]) == prod_{i=0}^{N-1} (alpha + i)
///
/// This proves the multiset {perm[i]} == {0, 1, ..., N-1} with overwhelming
/// probability (soundness error ≤ N / p, negligible for BN254).
///
/// Additionally, each perm[i] is range-checked to [0, N-1] using LessThan.
template PermutationCheck(N) {
    signal input perm[N];

    // --- Range check: each perm[i] must be in [0, N-1] ---
    // Uses circomlib's LessThan(n) which does proper bit decomposition.
    // 7 bits suffices since N=94 < 128 = 2^7.
    component range_check[N];
    for (var i = 0; i < N; i++) {
        range_check[i] = LessThan(7);
        range_check[i].in[0] <== perm[i];
        range_check[i].in[1] <== N;
        range_check[i].out === 1;
    }

    // --- Grand product argument ---
    // Derive challenge alpha from the permutation via Poseidon hash chain.
    // alpha = Poseidon(Poseidon(...Poseidon(perm[0], perm[1])..., perm[N-2]), perm[N-1])
    component challenge_hash[N - 1];
    signal challenge_chain[N];
    challenge_chain[0] <== perm[0];
    for (var i = 1; i < N; i++) {
        challenge_hash[i - 1] = Poseidon(2);
        challenge_hash[i - 1].inputs[0] <== challenge_chain[i - 1];
        challenge_hash[i - 1].inputs[1] <== perm[i];
        challenge_chain[i] <== challenge_hash[i - 1].out;
    }
    signal alpha <== challenge_chain[N - 1];

    // Compute prod(alpha + perm[i])
    signal perm_terms[N];
    signal perm_product[N + 1];
    perm_product[0] <== 1;
    for (var i = 0; i < N; i++) {
        perm_terms[i] <== alpha + perm[i];
        perm_product[i + 1] <== perm_product[i] * perm_terms[i];
    }

    // Compute prod(alpha + i)
    signal identity_terms[N];
    signal identity_product[N + 1];
    identity_product[0] <== 1;
    for (var i = 0; i < N; i++) {
        identity_terms[i] <== alpha + i;
        identity_product[i + 1] <== identity_product[i] * identity_terms[i];
    }

    // Grand product constraint
    perm_product[N] === identity_product[N];
}

/// CardLookup: Given an index `sel` and arrays of card fields,
/// outputs the card fields at position `sel`.
/// Uses circomlib Multiplexer for constrained array lookup.
template CardLookup(N) {
    signal input sel;
    signal input values[N];
    signal input types[N];
    signal input suits[N];
    signal output out_value;
    signal output out_type;
    signal output out_suit;

    // Pack the 3 card fields as a width-3 multiplexer with N inputs
    component mux = Multiplexer(3, N);
    mux.sel <== sel;
    for (var i = 0; i < N; i++) {
        mux.inp[i][0] <== values[i];
        mux.inp[i][1] <== types[i];
        mux.inp[i][2] <== suits[i];
    }
    out_value <== mux.out[0];
    out_type <== mux.out[1];
    out_suit <== mux.out[2];
}

template CardHash() {
    signal input value;
    signal input card_type;
    signal input suit;
    signal input index;
    signal output hash;

    component poseidon = Poseidon(4);
    poseidon.inputs[0] <== value;
    poseidon.inputs[1] <== card_type;
    poseidon.inputs[2] <== suit;
    poseidon.inputs[3] <== index;
    hash <== poseidon.out;
}

template MerkleRoot(DEPTH) {
    var NUM_LEAVES = 1 << DEPTH; // 2^DEPTH
    signal input leaves[NUM_LEAVES];
    signal output root;

    // Build tree bottom-up
    var total_nodes = 2 * NUM_LEAVES - 1;
    signal nodes[total_nodes];

    // Copy leaves to bottom level
    for (var i = 0; i < NUM_LEAVES; i++) {
        nodes[NUM_LEAVES - 1 + i] <== leaves[i];
    }

    // Internal nodes: hash pairs
    component hashers[NUM_LEAVES - 1];
    for (var i = NUM_LEAVES - 2; i >= 0; i--) {
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== nodes[2 * i + 1];
        hashers[i].inputs[1] <== nodes[2 * i + 2];
        nodes[i] <== hashers[i].out;
    }

    root <== nodes[0];
}

template CanonicalDeckHash(N) {
    signal input values[N];
    signal input types[N];
    signal input suits[N];
    signal output hash;

    // Hash each card: Poseidon(value, type, suit, index)
    component card_hashes[N];
    signal card_hash_values[N];
    for (var i = 0; i < N; i++) {
        card_hashes[i] = CardHash();
        card_hashes[i].value <== values[i];
        card_hashes[i].card_type <== types[i];
        card_hashes[i].suit <== suits[i];
        card_hashes[i].index <== i;
        card_hash_values[i] <== card_hashes[i].hash;
    }

    // Chain-hash all card hashes: Poseidon(h1, h2), then Poseidon(prev, h3), ...
    component chain[N - 1];
    signal running[N];
    running[0] <== card_hash_values[0];
    for (var i = 1; i < N; i++) {
        chain[i - 1] = Poseidon(2);
        chain[i - 1].inputs[0] <== running[i - 1];
        chain[i - 1].inputs[1] <== card_hash_values[i];
        running[i] <== chain[i - 1].out;
    }

    hash <== running[N - 1];
}

template ShuffleVerify(DECK_SIZE, TREE_DEPTH) {
    var NUM_LEAVES = 1 << TREE_DEPTH;

    // Public inputs
    signal input merkle_root;
    signal input canonical_hash;

    // Private inputs
    signal input permutation[DECK_SIZE];
    signal input canonical_values[DECK_SIZE];
    signal input canonical_types[DECK_SIZE];
    signal input canonical_suits[DECK_SIZE];

    // 1. Verify permutation is a valid bijection (grand product + range check)
    component perm_check = PermutationCheck(DECK_SIZE);
    for (var i = 0; i < DECK_SIZE; i++) {
        perm_check.perm[i] <== permutation[i];
    }

    // 2. Verify canonical deck hash matches public input
    component canon_hash = CanonicalDeckHash(DECK_SIZE);
    for (var i = 0; i < DECK_SIZE; i++) {
        canon_hash.values[i] <== canonical_values[i];
        canon_hash.types[i] <== canonical_types[i];
        canon_hash.suits[i] <== canonical_suits[i];
    }
    canonical_hash === canon_hash.hash;

    // 3. Apply permutation to get shuffled deck (CONSTRAINED)
    // shuffled[i] = canonical[permutation[i]] (forward mapping)
    // Uses Multiplexer for constrained array lookup.
    signal shuffled_values[DECK_SIZE];
    signal shuffled_types[DECK_SIZE];
    signal shuffled_suits[DECK_SIZE];

    component lookups[DECK_SIZE];
    for (var i = 0; i < DECK_SIZE; i++) {
        lookups[i] = CardLookup(DECK_SIZE);
        lookups[i].sel <== permutation[i];
        for (var j = 0; j < DECK_SIZE; j++) {
            lookups[i].values[j] <== canonical_values[j];
            lookups[i].types[j] <== canonical_types[j];
            lookups[i].suits[j] <== canonical_suits[j];
        }
        shuffled_values[i] <== lookups[i].out_value;
        shuffled_types[i] <== lookups[i].out_type;
        shuffled_suits[i] <== lookups[i].out_suit;
    }

    // 4. Hash shuffled cards into leaf hashes
    signal leaf_hashes[NUM_LEAVES];
    component shuffled_card_hashes[DECK_SIZE];
    for (var i = 0; i < DECK_SIZE; i++) {
        shuffled_card_hashes[i] = CardHash();
        shuffled_card_hashes[i].value <== shuffled_values[i];
        shuffled_card_hashes[i].card_type <== shuffled_types[i];
        shuffled_card_hashes[i].suit <== shuffled_suits[i];
        shuffled_card_hashes[i].index <== i;
        leaf_hashes[i] <== shuffled_card_hashes[i].hash;
    }

    // Padding leaves: Poseidon(0, 0, 0, index) for indices DECK_SIZE..NUM_LEAVES-1
    component padding_hashes[NUM_LEAVES - DECK_SIZE];
    for (var i = DECK_SIZE; i < NUM_LEAVES; i++) {
        padding_hashes[i - DECK_SIZE] = CardHash();
        padding_hashes[i - DECK_SIZE].value <== 0;
        padding_hashes[i - DECK_SIZE].card_type <== 0;
        padding_hashes[i - DECK_SIZE].suit <== 0;
        padding_hashes[i - DECK_SIZE].index <== i;
        leaf_hashes[i] <== padding_hashes[i - DECK_SIZE].hash;
    }

    // 5. Build Merkle tree and verify root
    component tree = MerkleRoot(TREE_DEPTH);
    for (var i = 0; i < NUM_LEAVES; i++) {
        tree.leaves[i] <== leaf_hashes[i];
    }
    merkle_root === tree.root;
}

// Instantiate with 94 cards and depth 7 (128 leaves)
component main {public [merkle_root, canonical_hash]} = ShuffleVerify(94, 7);
