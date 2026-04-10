use pinocchio::error::ProgramError;

use crate::errors::PushFlipError;
// Re-export the Poseidon helpers through this module so existing call sites
// keep working unchanged. The underlying implementation lives in
// `poseidon_native` and routes to the `sol_poseidon` syscall on the SBF
// target. **Do NOT add Poseidon logic to this file** — edit
// `poseidon_native.rs` instead. See that file for the byte-compatibility
// rationale and the `light_poseidon` host fallback used by unit tests.
pub use crate::zk::poseidon_native::{hash_card_leaf, hash_pair};

/// Merkle tree depth (128 leaves = 94 cards + 34 padding)
pub const MERKLE_DEPTH: usize = 7;

/// Verify a Merkle proof for a card at a given leaf position.
///
/// # Arguments
/// * `card_value`, `card_type`, `card_suit` - The revealed card's fields
/// * `leaf_index` - Position in the tree (0-93 for real cards, 94-127 for padding)
/// * `proof` - Sibling hashes along the path from leaf to root (7 hashes)
/// * `root` - The committed Merkle root stored on-chain
pub fn verify_merkle_proof(
    card_value: u8,
    card_type: u8,
    card_suit: u8,
    leaf_index: u8,
    proof: &[[u8; 32]; MERKLE_DEPTH],
    root: &[u8; 32],
) -> Result<(), ProgramError> {
    // Compute the leaf hash
    let mut current = hash_card_leaf(card_value, card_type, card_suit, leaf_index);

    // Walk up the tree
    let mut index = leaf_index as usize;
    for sibling in proof.iter() {
        if index & 1 == 0 {
            // Current node is left child
            current = hash_pair(&current, sibling);
        } else {
            // Current node is right child
            current = hash_pair(sibling, &current);
        }
        index >>= 1;
    }

    // Compare computed root with stored root
    if current != *root {
        return Err(PushFlipError::InvalidMerkleProof.into());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Total leaves including padding (2^MERKLE_DEPTH).
    const TOTAL_LEAVES: usize = 128;

    /// Hash for a padding leaf: Poseidon(0, 0, 0, leaf_index).
    fn hash_padding_leaf(leaf_index: u8) -> [u8; 32] {
        hash_card_leaf(0, 0, 0, leaf_index)
    }

    /// Build a complete Merkle tree from leaves and return (root, all_nodes).
    /// Nodes are stored level by level, bottom to top.
    fn build_tree(leaves: &[[u8; 32]]) -> ([u8; 32], Vec<Vec<[u8; 32]>>) {
        let mut levels: Vec<Vec<[u8; 32]>> = vec![leaves.to_vec()];
        let mut current = leaves.to_vec();

        while current.len() > 1 {
            let mut next = Vec::new();
            for chunk in current.chunks(2) {
                let left = &chunk[0];
                let right = if chunk.len() == 2 { &chunk[1] } else { left };
                next.push(hash_pair(left, right));
            }
            levels.push(next.clone());
            current = next;
        }

        (current[0], levels)
    }

    /// Extract a Merkle proof for a given leaf index from a built tree.
    fn extract_proof<const D: usize>(levels: &[Vec<[u8; 32]>], leaf_index: usize) -> [[u8; 32]; D] {
        let mut proof = [[0u8; 32]; D];
        let mut idx = leaf_index;

        for (level, sibling_hash) in proof.iter_mut().enumerate() {
            let sibling_idx = idx ^ 1;
            *sibling_hash = if sibling_idx < levels[level].len() {
                levels[level][sibling_idx]
            } else {
                levels[level][idx]
            };
            idx >>= 1;
        }

        proof
    }

    #[test]
    fn test_hash_card_leaf_deterministic() {
        let h1 = hash_card_leaf(5, 0, 2, 0);
        let h2 = hash_card_leaf(5, 0, 2, 0);
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_hash_different_inputs() {
        let h1 = hash_card_leaf(5, 0, 2, 0);
        let h2 = hash_card_leaf(6, 0, 2, 0);
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_merkle_proof_8_leaves() {
        // Build an 8-leaf tree (depth 3)
        let leaves: Vec<[u8; 32]> = (0..8u8).map(|i| hash_card_leaf(i + 1, 0, 0, i)).collect();

        let (root, levels) = build_tree(&leaves);
        let proof = extract_proof::<3>(&levels, 3);

        // Verify leaf 3 (value=4, type=0, suit=0, index=3)
        let mut current = hash_card_leaf(4, 0, 0, 3);
        let mut idx = 3usize;
        for sibling in proof.iter() {
            if idx & 1 == 0 {
                current = hash_pair(&current, sibling);
            } else {
                current = hash_pair(sibling, &current);
            }
            idx >>= 1;
        }
        assert_eq!(current, root);
    }

    #[test]
    fn test_merkle_proof_tampered_fails() {
        let leaves: Vec<[u8; 32]> = (0..8u8).map(|i| hash_card_leaf(i + 1, 0, 0, i)).collect();

        let (root, levels) = build_tree(&leaves);
        let mut proof = extract_proof::<3>(&levels, 3);

        // Tamper with a low byte to stay within BN254 field
        proof[1][31] ^= 0x01;

        let mut current = hash_card_leaf(4, 0, 0, 3);
        let mut idx = 3usize;
        for sibling in proof.iter() {
            if idx & 1 == 0 {
                current = hash_pair(&current, sibling);
            } else {
                current = hash_pair(sibling, &current);
            }
            idx >>= 1;
        }
        assert_ne!(current, root, "tampered proof should NOT match root");
    }

    #[test]
    fn test_merkle_proof_wrong_index_fails() {
        let leaves: Vec<[u8; 32]> = (0..8u8).map(|i| hash_card_leaf(i + 1, 0, 0, i)).collect();

        let (root, levels) = build_tree(&leaves);
        let proof = extract_proof::<3>(&levels, 3);

        // Use correct proof for index 3 but hash with wrong index 4
        let mut current = hash_card_leaf(4, 0, 0, 4); // wrong index!
        let mut idx = 3usize;
        for sibling in proof.iter() {
            if idx & 1 == 0 {
                current = hash_pair(&current, sibling);
            } else {
                current = hash_pair(sibling, &current);
            }
            idx >>= 1;
        }
        assert_ne!(current, root, "wrong leaf_index should NOT match root");
    }

    #[test]
    fn test_padding_leaf_differs_from_card() {
        let card = hash_card_leaf(1, 0, 0, 94);
        let padding = hash_padding_leaf(94);
        // Padding has value=0, card has value=1
        assert_ne!(card, padding);
    }

    #[test]
    fn test_canonical_deck_hash_matches_js() {
        // Cross-validate: this hash must match the JS computation in
        // zk-circuits/scripts/compute_canonical_hash.mjs
        use crate::utils::deck::{create_canonical_deck, DECK_SIZE};

        let deck = create_canonical_deck();
        let mut card_hashes = Vec::with_capacity(DECK_SIZE);
        for (i, card) in deck.iter().enumerate() {
            card_hashes.push(hash_card_leaf(
                card.value,
                card.card_type,
                card.suit,
                i as u8,
            ));
        }

        // Chain hash: Poseidon(h_prev, h_next)
        let mut running = card_hashes[0];
        for hash in &card_hashes[1..] {
            running = hash_pair(&running, hash);
        }

        let expected = crate::zk::verifying_key::CANONICAL_DECK_HASH;
        assert_eq!(
            running, expected,
            "Rust canonical hash doesn't match JS — Poseidon params diverged!"
        );
    }

    #[test]
    fn test_verify_merkle_proof_full_depth() {
        // Build a depth-7 tree (128 leaves) with 8 real + 120 padding
        let mut leaves = Vec::with_capacity(TOTAL_LEAVES);
        for i in 0..8u8 {
            leaves.push(hash_card_leaf(i + 1, 0, 0, i));
        }
        for i in 8..TOTAL_LEAVES as u8 {
            leaves.push(hash_padding_leaf(i));
        }

        let (root, levels) = build_tree(&leaves);
        let proof = extract_proof::<MERKLE_DEPTH>(&levels, 3);

        // Should succeed
        assert!(verify_merkle_proof(4, 0, 0, 3, &proof, &root).is_ok());

        // Wrong card value should fail
        assert!(verify_merkle_proof(5, 0, 0, 3, &proof, &root).is_err());
    }
}
