/// BountyBoard discriminator
pub const BOUNTY_BOARD_DISCRIMINATOR: u8 = 3;

/// Allocate 1500 bytes for safety
pub const BOUNTY_BOARD_SIZE: usize = 1500;

/// Maximum bounties per game
pub const MAX_BOUNTIES: usize = 10;

/// Bounty types
pub const SEVEN_CARD_WIN: u8 = 0; // PushFlip (7 cards, no bust)
pub const HIGH_SCORE: u8 = 1; // Score above threshold
pub const SURVIVOR: u8 = 2; // Last active player
pub const COMEBACK: u8 = 3; // Used second chance and still won

/// PDA seeds: ["bounty", game_session_address]
pub const BOUNTY_SEED: &[u8] = b"bounty";

/// Single bounty: 42 bytes
/// [0]      bounty_type (u8)
/// [1..9]   reward_amount (u64)
/// [9]      is_active (bool)
/// [10..42] claimed_by (Pubkey, 32 bytes — zero if unclaimed)
pub const BOUNTY_SIZE: usize = 42;

// Byte offsets for BountyBoard
const DISCRIMINATOR: usize = 0; // u8
const BUMP: usize = 1; // u8
const GAME_SESSION: usize = 2; // Pubkey (32 bytes)
const BOUNTY_COUNT: usize = 34; // u8
const BOUNTIES: usize = 35; // [Bounty; MAX_BOUNTIES] = 10 * 42 = 420 bytes
                            // Total used: 455 bytes, padded to 1500

const MIN_DATA_LEN: usize = BOUNTIES + MAX_BOUNTIES * BOUNTY_SIZE; // 455

pub struct BountyBoard<'a> {
    data: &'a [u8],
}

pub struct BountyBoardMut<'a> {
    data: &'a mut [u8],
}

impl<'a> BountyBoard<'a> {
    pub fn from_bytes(data: &'a [u8]) -> Self {
        assert!(data.len() >= MIN_DATA_LEN);
        Self { data }
    }

    pub fn discriminator(&self) -> u8 {
        self.data[DISCRIMINATOR]
    }

    pub fn bump(&self) -> u8 {
        self.data[BUMP]
    }

    pub fn game_session(&self) -> &[u8; 32] {
        self.data[GAME_SESSION..GAME_SESSION + 32]
            .try_into()
            .unwrap()
    }

    pub fn bounty_count(&self) -> u8 {
        self.data[BOUNTY_COUNT]
    }

    pub fn bounty_type(&self, index: usize) -> u8 {
        assert!(index < MAX_BOUNTIES);
        let offset = BOUNTIES + index * BOUNTY_SIZE;
        self.data[offset]
    }

    pub fn bounty_reward(&self, index: usize) -> u64 {
        assert!(index < MAX_BOUNTIES);
        let offset = BOUNTIES + index * BOUNTY_SIZE + 1;
        u64::from_le_bytes(self.data[offset..offset + 8].try_into().unwrap())
    }

    pub fn bounty_is_active(&self, index: usize) -> bool {
        assert!(index < MAX_BOUNTIES);
        let offset = BOUNTIES + index * BOUNTY_SIZE + 9;
        self.data[offset] != 0
    }

    pub fn bounty_claimed_by(&self, index: usize) -> &[u8; 32] {
        assert!(index < MAX_BOUNTIES);
        let offset = BOUNTIES + index * BOUNTY_SIZE + 10;
        self.data[offset..offset + 32].try_into().unwrap()
    }
}

impl<'a> BountyBoardMut<'a> {
    pub fn from_bytes(data: &'a mut [u8]) -> Self {
        assert!(data.len() >= MIN_DATA_LEN);
        Self { data }
    }

    pub fn as_ref(&self) -> BountyBoard<'_> {
        BountyBoard { data: self.data }
    }

    pub fn set_discriminator(&mut self, val: u8) {
        self.data[DISCRIMINATOR] = val;
    }

    pub fn set_bump(&mut self, val: u8) {
        self.data[BUMP] = val;
    }

    pub fn set_game_session(&mut self, val: &[u8; 32]) {
        self.data[GAME_SESSION..GAME_SESSION + 32].copy_from_slice(val);
    }

    pub fn set_bounty_count(&mut self, val: u8) {
        self.data[BOUNTY_COUNT] = val;
    }

    pub fn set_bounty_type(&mut self, index: usize, val: u8) {
        assert!(index < MAX_BOUNTIES);
        let offset = BOUNTIES + index * BOUNTY_SIZE;
        self.data[offset] = val;
    }

    pub fn set_bounty_reward(&mut self, index: usize, val: u64) {
        assert!(index < MAX_BOUNTIES);
        let offset = BOUNTIES + index * BOUNTY_SIZE + 1;
        self.data[offset..offset + 8].copy_from_slice(&val.to_le_bytes());
    }

    pub fn set_bounty_is_active(&mut self, index: usize, val: bool) {
        assert!(index < MAX_BOUNTIES);
        let offset = BOUNTIES + index * BOUNTY_SIZE + 9;
        self.data[offset] = val as u8;
    }

    pub fn set_bounty_claimed_by(&mut self, index: usize, val: &[u8; 32]) {
        assert!(index < MAX_BOUNTIES);
        let offset = BOUNTIES + index * BOUNTY_SIZE + 10;
        self.data[offset..offset + 32].copy_from_slice(val);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bounty_board_roundtrip() {
        let mut buf = [0u8; BOUNTY_BOARD_SIZE];
        let gs_key = [1u8; 32];

        {
            let mut bb = BountyBoardMut::from_bytes(&mut buf);
            bb.set_discriminator(BOUNTY_BOARD_DISCRIMINATOR);
            bb.set_bump(253);
            bb.set_game_session(&gs_key);
            bb.set_bounty_count(2);

            bb.set_bounty_type(0, SEVEN_CARD_WIN);
            bb.set_bounty_reward(0, 1_000_000_000);
            bb.set_bounty_is_active(0, true);

            bb.set_bounty_type(1, HIGH_SCORE);
            bb.set_bounty_reward(1, 500_000_000);
            bb.set_bounty_is_active(1, true);
        }

        let bb = BountyBoard::from_bytes(&buf);
        assert_eq!(bb.discriminator(), BOUNTY_BOARD_DISCRIMINATOR);
        assert_eq!(bb.game_session(), &gs_key);
        assert_eq!(bb.bounty_count(), 2);
        assert_eq!(bb.bounty_type(0), SEVEN_CARD_WIN);
        assert_eq!(bb.bounty_reward(0), 1_000_000_000);
        assert!(bb.bounty_is_active(0));
        assert_eq!(bb.bounty_type(1), HIGH_SCORE);
    }

    #[test]
    fn test_layout_fits() {
        assert!(BOUNTIES + MAX_BOUNTIES * BOUNTY_SIZE <= BOUNTY_BOARD_SIZE);
    }
}
