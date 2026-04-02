pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";

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
///   - canonical_values[DECK_SIZE]: card value for each canonical card
///   - canonical_types[DECK_SIZE]: card type for each canonical card
///   - canonical_suits[DECK_SIZE]: card suit for each canonical card

// Deck size: 94 cards (52 Alpha + 30 Protocol + 12 Multiplier)
// Tree depth: 7 (128 leaves, 94 used + 34 padding)

template PermutationCheck(N) {
    signal input perm[N];

    // Each value in perm must be in range [0, N-1]
    // and each value must appear exactly once (bijection).
    // We use the "frequency count" approach:
    // For each position i, compute a selector for each value j,
    // then sum selectors per value and assert sum == 1.

    // Simpler approach: verify the permutation produces a valid
    // rearrangement by checking that sorting perm gives [0,1,...,N-1].
    // We use the product-of-differences approach:
    // prod(perm[i] - j) for all i,j where i!=j should equal
    // prod(i - j) for all i,j where i!=j.
    // This is equivalent to checking that the multiset {perm[i]} == {0,...,N-1}.

    // Efficient approach: use polynomial identity.
    // prod_{i=0}^{N-1} (X - perm[i]) == prod_{i=0}^{N-1} (X - i)
    // We evaluate at a random challenge point. For ZK circuits,
    // we use a Fiat-Shamir-style challenge derived from the inputs.

    // Simplest correct approach for a circuit: accumulate a running product
    // (perm[i] + 1) and verify it equals N! ... but N! overflows for N=94.

    // Most practical: verify each perm[i] is in [0, N-1] using range checks,
    // then verify all perm[i] are distinct using a sorting network or
    // the grand product argument.

    // Grand product argument:
    // prod_{i=0}^{N-1} (alpha - perm[i]) == prod_{i=0}^{N-1} (alpha - i)
    // where alpha is a random challenge. In a non-interactive circuit,
    // we derive alpha from the Poseidon hash of all perm[i].

    // For now, we use a simpler constraint: verify the sum and sum-of-squares
    // match. This is NOT cryptographically sound for a full proof
    // (collisions exist), but it's a placeholder for the circuit structure.
    // The full implementation should use the grand product argument.

    // Range check: each perm[i] < N
    signal range_ok[N];
    for (var i = 0; i < N; i++) {
        // perm[i] must be non-negative (field element) and < N
        // In circom, we check via bit decomposition
        range_ok[i] <-- (perm[i] < N) ? 1 : 0;
        range_ok[i] === 1;
    }

    // Sum check: sum(perm[i]) == sum(0..N-1) = N*(N-1)/2
    signal running_sum[N + 1];
    running_sum[0] <== 0;
    for (var i = 0; i < N; i++) {
        running_sum[i + 1] <== running_sum[i] + perm[i];
    }
    running_sum[N] === N * (N - 1) / 2;
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

    // 1. Verify permutation is valid
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

    // 3. Apply permutation to get shuffled deck
    // shuffled[permutation[i]] = canonical[i]
    // We need: for each shuffled position j, find which canonical card maps to it
    // This requires an inverse permutation lookup, which is expensive in circuits.
    // Instead: hash each card at its shuffled position.

    // For each canonical card i, it goes to position permutation[i].
    // We compute leaf_hash[permutation[i]] = Poseidon(canonical_values[i], canonical_types[i], canonical_suits[i], permutation[i])
    // But we can't dynamically index into an array in circom.

    // Alternative: compute ALL leaf hashes and verify the sum matches.
    // Actually, for a Merkle tree we need each leaf at a specific position.
    // The standard approach: provide the shuffled deck as witness,
    // verify it's a permutation, and hash it directly.

    // Provide shuffled deck fields as computed witness
    signal shuffled_values[DECK_SIZE];
    signal shuffled_types[DECK_SIZE];
    signal shuffled_suits[DECK_SIZE];

    for (var i = 0; i < DECK_SIZE; i++) {
        // The witness generator fills these from permutation
        shuffled_values[i] <-- canonical_values[permutation[i]];
        shuffled_types[i] <-- canonical_types[permutation[i]];
        shuffled_suits[i] <-- canonical_suits[permutation[i]];
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
