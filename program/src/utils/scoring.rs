use crate::state::card::{Card, ALPHA, MULTIPLIER};

/// Calculate the score for a hand of cards.
///
/// - Alpha cards: sum their values
/// - Protocol cards: contribute 0 to score
/// - Multiplier cards: multiply the alpha sum (2x, 3x, 5x)
///   Multiple multipliers stack multiplicatively.
pub fn calculate_hand_score(hand: &[Card], hand_size: u8) -> u64 {
    let count = hand_size as usize;

    let alpha_sum: u64 = hand[..count]
        .iter()
        .filter(|c| c.card_type == ALPHA)
        .map(|c| c.value as u64)
        .sum();

    let multiplier: u64 = hand[..count]
        .iter()
        .filter(|c| c.card_type == MULTIPLIER)
        .map(|c| c.value as u64)
        .product();

    // If no multiplier cards, product() returns 1 (identity for empty iterator
    // is handled below since an empty product of u64 is actually 1 in Rust's
    // Iterator::product for numeric types, but let's be explicit)
    if hand[..count].iter().any(|c| c.card_type == MULTIPLIER) {
        alpha_sum.saturating_mul(multiplier)
    } else {
        alpha_sum
    }
}

/// Check if a hand has busted (two Alpha cards with the same value).
pub fn check_bust(hand: &[Card], hand_size: u8) -> Option<u8> {
    let count = hand_size as usize;

    // Track which alpha values we've seen (values 1-13)
    let mut seen = [false; 14];

    for card in &hand[..count] {
        if card.card_type == ALPHA {
            let v = card.value as usize;
            if v > 0 && v < 14 && seen[v] {
                return Some(card.value);
            }
            if v > 0 && v < 14 {
                seen[v] = true;
            }
        }
    }

    None
}

/// Check if a hand qualifies as a PushFlip (exactly 7 cards without busting).
pub fn check_pushflip(hand: &[Card], hand_size: u8) -> bool {
    hand_size == 7 && check_bust(hand, hand_size).is_none()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::card::{PROTOCOL, RUG_PULL};

    fn alpha(value: u8) -> Card {
        Card::new(value, ALPHA, 0)
    }

    fn multiplier(value: u8) -> Card {
        Card::new(value, MULTIPLIER, 0)
    }

    fn protocol() -> Card {
        Card::new(RUG_PULL, PROTOCOL, 0)
    }

    #[test]
    fn test_basic_score() {
        let hand = [alpha(5), alpha(10)];
        assert_eq!(calculate_hand_score(&hand, 2), 15);
    }

    #[test]
    fn test_multiplier_score() {
        let hand = [alpha(5), alpha(10), multiplier(3)];
        assert_eq!(calculate_hand_score(&hand, 3), 45);
    }

    #[test]
    fn test_multiple_multipliers() {
        let hand = [alpha(10), multiplier(2), multiplier(3)];
        assert_eq!(calculate_hand_score(&hand, 3), 60);
    }

    #[test]
    fn test_protocol_no_score() {
        let hand = [alpha(5), protocol(), alpha(10)];
        assert_eq!(calculate_hand_score(&hand, 3), 15);
    }

    #[test]
    fn test_bust_duplicate() {
        let hand = [alpha(7), alpha(3), alpha(7)];
        assert_eq!(check_bust(&hand, 3), Some(7));
    }

    #[test]
    fn test_no_bust() {
        let hand = [alpha(7), alpha(8), alpha(9)];
        assert_eq!(check_bust(&hand, 3), None);
    }

    #[test]
    fn test_pushflip() {
        let hand = [
            alpha(1),
            alpha(2),
            alpha(3),
            alpha(4),
            alpha(5),
            alpha(6),
            alpha(7),
        ];
        assert!(check_pushflip(&hand, 7));
    }

    #[test]
    fn test_not_pushflip_wrong_count() {
        let hand = [alpha(1), alpha(2), alpha(3), alpha(4), alpha(5), alpha(6)];
        assert!(!check_pushflip(&hand, 6));
    }

    #[test]
    fn test_not_pushflip_bust() {
        let hand = [
            alpha(1),
            alpha(2),
            alpha(3),
            alpha(4),
            alpha(5),
            alpha(6),
            alpha(1), // duplicate!
        ];
        assert!(!check_pushflip(&hand, 7));
    }

    #[test]
    fn test_empty_hand() {
        let hand: [Card; 0] = [];
        assert_eq!(calculate_hand_score(&hand, 0), 0);
        assert_eq!(check_bust(&hand, 0), None);
    }

    #[test]
    fn test_5x_multiplier() {
        let hand = [alpha(10), multiplier(5)];
        assert_eq!(calculate_hand_score(&hand, 2), 50);
    }
}
