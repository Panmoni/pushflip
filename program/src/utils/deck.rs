use crate::state::card::{Card, AIRDROP, ALPHA, MULTIPLIER, PROTOCOL, RUG_PULL, VAMPIRE_ATTACK};

/// Total cards in the deck
pub const DECK_SIZE: usize = 94;

/// Number of Alpha cards (standard playing cards)
pub const ALPHA_COUNT: usize = 52;

/// Number of Protocol cards
pub const PROTOCOL_COUNT: usize = 30;

/// Number of Multiplier cards
pub const MULTIPLIER_COUNT: usize = 12;

/// Creates the canonical 94-card deck in a deterministic order.
///
/// Layout:
/// - 52 Alpha cards: suits 0-3, values 1-13 each (52 total)
/// - 30 Protocol cards: 10 RugPull, 10 Airdrop, 10 VampireAttack
/// - 12 Multiplier cards: 4x2, 4x3, 4x5
///
/// This ordering must be identical across the on-chain program, the
/// off-chain dealer, and the Circom circuit.
pub fn create_canonical_deck() -> [Card; DECK_SIZE] {
    let mut deck = [Card::new(0, 0, 0); DECK_SIZE];
    let mut i = 0;

    // 52 Alpha cards: 4 suits × 13 values
    for suit in 0..4u8 {
        for value in 1..=13u8 {
            deck[i] = Card::new(value, ALPHA, suit);
            i += 1;
        }
    }

    // 10 RugPull, 10 Airdrop, 10 VampireAttack
    for effect in [RUG_PULL, AIRDROP, VAMPIRE_ATTACK] {
        for _ in 0..10 {
            deck[i] = Card::new(effect, PROTOCOL, 0);
            i += 1;
        }
    }

    // 4×2x, 4×3x, 4×5x multipliers
    for multiplier in [2u8, 3, 5] {
        for _ in 0..4 {
            deck[i] = Card::new(multiplier, MULTIPLIER, 0);
            i += 1;
        }
    }

    assert!(i == DECK_SIZE);
    deck
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deck_size() {
        let deck = create_canonical_deck();
        assert_eq!(deck.len(), 94);
    }

    #[test]
    fn test_deck_composition() {
        let deck = create_canonical_deck();
        let alpha = deck.iter().filter(|c| c.is_alpha()).count();
        let protocol = deck.iter().filter(|c| c.is_protocol()).count();
        let multiplier = deck.iter().filter(|c| c.is_multiplier()).count();

        assert_eq!(alpha, ALPHA_COUNT);
        assert_eq!(protocol, PROTOCOL_COUNT);
        assert_eq!(multiplier, MULTIPLIER_COUNT);
    }

    #[test]
    fn test_canonical_order_deterministic() {
        let deck1 = create_canonical_deck();
        let deck2 = create_canonical_deck();
        assert_eq!(deck1, deck2);
    }

    #[test]
    fn test_alpha_cards_correct() {
        let deck = create_canonical_deck();
        // First card: suit 0, value 1
        assert_eq!(deck[0], Card::new(1, ALPHA, 0));
        // Last alpha card: suit 3, value 13
        assert_eq!(deck[51], Card::new(13, ALPHA, 3));
    }

    #[test]
    fn test_protocol_cards_correct() {
        let deck = create_canonical_deck();
        // First protocol card: RugPull at index 52
        assert_eq!(deck[52], Card::new(RUG_PULL, PROTOCOL, 0));
        // First Airdrop at index 62
        assert_eq!(deck[62], Card::new(AIRDROP, PROTOCOL, 0));
        // First VampireAttack at index 72
        assert_eq!(deck[72], Card::new(VAMPIRE_ATTACK, PROTOCOL, 0));
    }

    #[test]
    fn test_multiplier_cards_correct() {
        let deck = create_canonical_deck();
        // First 2x at index 82
        assert_eq!(deck[82], Card::new(2, MULTIPLIER, 0));
        // First 3x at index 86
        assert_eq!(deck[86], Card::new(3, MULTIPLIER, 0));
        // First 5x at index 90
        assert_eq!(deck[90], Card::new(5, MULTIPLIER, 0));
    }
}
