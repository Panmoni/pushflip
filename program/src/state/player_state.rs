use super::card::Card;

/// PlayerState discriminator
pub const PLAYER_STATE_DISCRIMINATOR: u8 = 2;

/// Allocate 256 bytes for safety
pub const PLAYER_STATE_SIZE: usize = 256;

/// Maximum cards in a hand
pub const MAX_HAND_SIZE: usize = 10;

// Byte offsets for zero-copy layout
const DISCRIMINATOR: usize = 0; // u8
const BUMP: usize = 1; // u8
const PLAYER: usize = 2; // Pubkey (32 bytes)
const GAME_ID: usize = 34; // u64 (8 bytes)
const HAND_SIZE: usize = 42; // u8
const HAND: usize = 43; // [Card; 10] = 30 bytes (10 * 3)
const IS_ACTIVE: usize = 73; // bool (u8)
const INACTIVE_REASON: usize = 74; // u8: 0=active, 1=bust, 2=stay
const BUST_CARD_VALUE: usize = 75; // u8: alpha value that caused bust (0=none)
const SCORE: usize = 76; // u64 (8 bytes)
const STAKED_AMOUNT: usize = 84; // u64 (8 bytes)
const HAS_USED_SECOND_CHANCE: usize = 92; // bool (u8)
const HAS_USED_SCRY: usize = 93; // bool (u8)
const TOTAL_WINS: usize = 94; // u64 (8 bytes)
const TOTAL_GAMES: usize = 102; // u64 (8 bytes)
// Total used: 110 bytes, padded to 256

/// Minimum valid data length for a PlayerState account
const MIN_DATA_LEN: usize = TOTAL_GAMES + 8; // 110

/// PDA seeds: ["player", game_id.to_le_bytes(), player_pubkey]
pub const PLAYER_SEED: &[u8] = b"player";

/// Inactive reasons
pub const ACTIVE: u8 = 0;
pub const BUST: u8 = 1;
pub const STAYED: u8 = 2;

/// Helper: read a u64 from a slice at a known offset (little-endian).
fn read_u64(data: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}

/// Zero-copy wrapper over a PlayerState account's byte slice.
///
/// # Safety contract
/// `from_bytes()` validates that `data.len() >= MIN_DATA_LEN` (110).
/// All accessors read at offsets <= 102+8 = 110, so they cannot
/// go out of bounds after that check.
pub struct PlayerState<'a> {
    data: &'a [u8],
}

/// Mutable zero-copy wrapper.
pub struct PlayerStateMut<'a> {
    data: &'a mut [u8],
}

impl<'a> PlayerState<'a> {
    pub fn from_bytes(data: &'a [u8]) -> Self {
        assert!(
            data.len() >= MIN_DATA_LEN,
            "PlayerState: data too short ({} < {})",
            data.len(),
            MIN_DATA_LEN,
        );
        Self { data }
    }

    pub fn discriminator(&self) -> u8 {
        self.data[DISCRIMINATOR]
    }

    pub fn bump(&self) -> u8 {
        self.data[BUMP]
    }

    pub fn player(&self) -> &[u8; 32] {
        self.data[PLAYER..PLAYER + 32].try_into().unwrap()
    }

    pub fn game_id(&self) -> u64 {
        read_u64(self.data, GAME_ID)
    }

    pub fn hand_size(&self) -> u8 {
        self.data[HAND_SIZE]
    }

    pub fn card_at(&self, index: usize) -> Card {
        assert!(index < MAX_HAND_SIZE, "card_at index out of bounds");
        let offset = HAND + index * Card::SIZE;
        Card::from_bytes(&self.data[offset..offset + Card::SIZE])
    }

    pub fn hand(&self) -> impl Iterator<Item = Card> + '_ {
        let size = core::cmp::min(self.hand_size() as usize, MAX_HAND_SIZE);
        (0..size).map(move |i| self.card_at(i))
    }

    pub fn is_active(&self) -> bool {
        self.data[IS_ACTIVE] != 0
    }

    pub fn inactive_reason(&self) -> u8 {
        self.data[INACTIVE_REASON]
    }

    pub fn bust_card_value(&self) -> u8 {
        self.data[BUST_CARD_VALUE]
    }

    pub fn score(&self) -> u64 {
        read_u64(self.data, SCORE)
    }

    pub fn staked_amount(&self) -> u64 {
        read_u64(self.data, STAKED_AMOUNT)
    }

    pub fn has_used_second_chance(&self) -> bool {
        self.data[HAS_USED_SECOND_CHANCE] != 0
    }

    pub fn has_used_scry(&self) -> bool {
        self.data[HAS_USED_SCRY] != 0
    }

    pub fn total_wins(&self) -> u64 {
        read_u64(self.data, TOTAL_WINS)
    }

    pub fn total_games(&self) -> u64 {
        read_u64(self.data, TOTAL_GAMES)
    }
}

impl<'a> PlayerStateMut<'a> {
    pub fn from_bytes(data: &'a mut [u8]) -> Self {
        assert!(
            data.len() >= MIN_DATA_LEN,
            "PlayerStateMut: data too short ({} < {})",
            data.len(),
            MIN_DATA_LEN,
        );
        Self { data }
    }

    pub fn as_ref(&self) -> PlayerState<'_> {
        PlayerState { data: self.data }
    }

    pub fn set_discriminator(&mut self, val: u8) {
        self.data[DISCRIMINATOR] = val;
    }

    pub fn set_bump(&mut self, val: u8) {
        self.data[BUMP] = val;
    }

    pub fn set_player(&mut self, val: &[u8; 32]) {
        self.data[PLAYER..PLAYER + 32].copy_from_slice(val);
    }

    pub fn set_game_id(&mut self, val: u64) {
        self.data[GAME_ID..GAME_ID + 8].copy_from_slice(&val.to_le_bytes());
    }

    pub fn set_hand_size(&mut self, val: u8) {
        self.data[HAND_SIZE] = val;
    }

    pub fn set_card_at(&mut self, index: usize, card: &Card) {
        assert!(index < MAX_HAND_SIZE, "set_card_at index out of bounds");
        let offset = HAND + index * Card::SIZE;
        self.data[offset..offset + Card::SIZE].copy_from_slice(&card.to_bytes());
    }

    /// Add a card to the end of the hand and increment hand_size.
    /// Panics if hand is already full (10 cards).
    pub fn push_card(&mut self, card: &Card) {
        let index = self.as_ref().hand_size() as usize;
        assert!(index < MAX_HAND_SIZE, "hand is full, cannot push card");
        self.set_card_at(index, card);
        self.set_hand_size(index as u8 + 1);
    }

    /// Remove the last card from the hand and decrement hand_size.
    pub fn pop_card(&mut self) {
        let size = self.as_ref().hand_size();
        if size > 0 {
            self.set_hand_size(size - 1);
        }
    }

    pub fn set_is_active(&mut self, val: bool) {
        self.data[IS_ACTIVE] = val as u8;
    }

    pub fn set_inactive_reason(&mut self, val: u8) {
        self.data[INACTIVE_REASON] = val;
    }

    pub fn set_bust_card_value(&mut self, val: u8) {
        self.data[BUST_CARD_VALUE] = val;
    }

    pub fn set_score(&mut self, val: u64) {
        self.data[SCORE..SCORE + 8].copy_from_slice(&val.to_le_bytes());
    }

    pub fn set_staked_amount(&mut self, val: u64) {
        self.data[STAKED_AMOUNT..STAKED_AMOUNT + 8].copy_from_slice(&val.to_le_bytes());
    }

    pub fn set_has_used_second_chance(&mut self, val: bool) {
        self.data[HAS_USED_SECOND_CHANCE] = val as u8;
    }

    pub fn set_has_used_scry(&mut self, val: bool) {
        self.data[HAS_USED_SCRY] = val as u8;
    }

    pub fn set_total_wins(&mut self, val: u64) {
        self.data[TOTAL_WINS..TOTAL_WINS + 8].copy_from_slice(&val.to_le_bytes());
    }

    pub fn set_total_games(&mut self, val: u64) {
        self.data[TOTAL_GAMES..TOTAL_GAMES + 8].copy_from_slice(&val.to_le_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::card::ALPHA;

    #[test]
    fn test_player_state_roundtrip() {
        let mut buf = [0u8; PLAYER_STATE_SIZE];
        let player_key = [42u8; 32];

        {
            let mut ps = PlayerStateMut::from_bytes(&mut buf);
            ps.set_discriminator(PLAYER_STATE_DISCRIMINATOR);
            ps.set_bump(254);
            ps.set_player(&player_key);
            ps.set_game_id(7);
            ps.set_is_active(true);
            ps.set_inactive_reason(ACTIVE);
            ps.set_score(0);
            ps.set_staked_amount(100_000_000_000);
        }

        let ps = PlayerState::from_bytes(&buf);
        assert_eq!(ps.discriminator(), PLAYER_STATE_DISCRIMINATOR);
        assert_eq!(ps.bump(), 254);
        assert_eq!(ps.player(), &player_key);
        assert_eq!(ps.game_id(), 7);
        assert!(ps.is_active());
        assert_eq!(ps.inactive_reason(), ACTIVE);
        assert_eq!(ps.score(), 0);
        assert_eq!(ps.staked_amount(), 100_000_000_000);
    }

    #[test]
    fn test_hand_operations() {
        let mut buf = [0u8; PLAYER_STATE_SIZE];
        let card1 = Card::new(5, ALPHA, 0);
        let card2 = Card::new(10, ALPHA, 1);

        let mut ps = PlayerStateMut::from_bytes(&mut buf);
        ps.push_card(&card1);
        ps.push_card(&card2);

        assert_eq!(ps.as_ref().hand_size(), 2);
        assert_eq!(ps.as_ref().card_at(0), card1);
        assert_eq!(ps.as_ref().card_at(1), card2);

        ps.pop_card();
        assert_eq!(ps.as_ref().hand_size(), 1);
    }

    #[test]
    #[should_panic(expected = "hand is full")]
    fn test_push_card_overflow() {
        let mut buf = [0u8; PLAYER_STATE_SIZE];
        let mut ps = PlayerStateMut::from_bytes(&mut buf);
        for i in 0..11 {
            ps.push_card(&Card::new(i, ALPHA, 0));
        }
    }

    #[test]
    #[should_panic(expected = "card_at index out of bounds")]
    fn test_card_at_out_of_bounds() {
        let buf = [0u8; PLAYER_STATE_SIZE];
        let ps = PlayerState::from_bytes(&buf);
        let _ = ps.card_at(10);
    }

    #[test]
    #[should_panic(expected = "data too short")]
    fn test_from_bytes_too_short() {
        let buf = [0u8; 10];
        let _ = PlayerState::from_bytes(&buf);
    }

    #[test]
    fn test_layout_fits_in_allocation() {
        assert!(TOTAL_GAMES + 8 <= PLAYER_STATE_SIZE);
    }
}
