/// Card types
pub const ALPHA: u8 = 0;
pub const PROTOCOL: u8 = 1;
pub const MULTIPLIER: u8 = 2;

/// Protocol card effects
pub const RUG_PULL: u8 = 0;
pub const AIRDROP: u8 = 1;
pub const VAMPIRE_ATTACK: u8 = 2;

/// A card packed into 3 bytes: [value, card_type, suit]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Card {
    pub value: u8,
    pub card_type: u8,
    pub suit: u8,
}

impl Card {
    pub const SIZE: usize = 3;

    pub const fn new(value: u8, card_type: u8, suit: u8) -> Self {
        Self {
            value,
            card_type,
            suit,
        }
    }

    pub fn from_bytes(data: &[u8]) -> Self {
        Self {
            value: data[0],
            card_type: data[1],
            suit: data[2],
        }
    }

    pub fn to_bytes(&self) -> [u8; 3] {
        [self.value, self.card_type, self.suit]
    }

    pub fn is_alpha(&self) -> bool {
        self.card_type == ALPHA
    }

    pub fn is_protocol(&self) -> bool {
        self.card_type == PROTOCOL
    }

    pub fn is_multiplier(&self) -> bool {
        self.card_type == MULTIPLIER
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_card_roundtrip() {
        let card = Card::new(7, ALPHA, 2);
        let bytes = card.to_bytes();
        let restored = Card::from_bytes(&bytes);
        assert_eq!(card, restored);
    }

    #[test]
    fn test_card_size() {
        assert_eq!(Card::SIZE, 3);
    }

    #[test]
    fn test_card_type_checks() {
        assert!(Card::new(5, ALPHA, 0).is_alpha());
        assert!(Card::new(0, PROTOCOL, 0).is_protocol());
        assert!(Card::new(2, MULTIPLIER, 0).is_multiplier());
    }
}
