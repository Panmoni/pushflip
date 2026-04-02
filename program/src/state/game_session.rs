/// GameSession discriminator
pub const GAME_SESSION_DISCRIMINATOR: u8 = 1;

/// Allocate 512 bytes for safety
pub const GAME_SESSION_SIZE: usize = 512;

/// Maximum players in a game (house + 3 humans)
pub const MAX_PLAYERS: usize = 4;

// Byte offsets for zero-copy layout
const DISCRIMINATOR: usize = 0; // u8
const BUMP: usize = 1; // u8
const GAME_ID: usize = 2; // u64 (8 bytes)
const AUTHORITY: usize = 10; // Pubkey (32 bytes)
const HOUSE: usize = 42; // Pubkey (32 bytes)
const DEALER: usize = 74; // Pubkey (32 bytes)
const TREASURY: usize = 106; // Pubkey (32 bytes)
const TOKEN_MINT: usize = 138; // Pubkey (32 bytes)
const VAULT: usize = 170; // Pubkey (32 bytes)
const PLAYER_COUNT: usize = 202; // u8
const TURN_ORDER: usize = 203; // [Pubkey; 4] = 128 bytes
const CURRENT_TURN_INDEX: usize = 331; // u8
const ROUND_ACTIVE: usize = 332; // bool (u8)
const ROUND_NUMBER: usize = 333; // u64 (8 bytes)
const POT_AMOUNT: usize = 341; // u64 (8 bytes)
const MERKLE_ROOT: usize = 349; // [u8; 32]
const DECK_COMMITTED: usize = 381; // bool (u8)
const DRAW_COUNTER: usize = 382; // u8
const TREASURY_FEE_BPS: usize = 383; // u16 (2 bytes)
const ROLLOVER_COUNT: usize = 385; // u8
const LAST_ACTION_SLOT: usize = 386; // u64 (8 bytes)
const VAULT_BUMP: usize = 394; // u8
                               // Total used: 395 bytes, padded to 512

/// Minimum valid data length for a GameSession account
const MIN_DATA_LEN: usize = VAULT_BUMP + 1; // 395

/// PDA seeds: ["game", game_id.to_le_bytes()]
pub const GAME_SEED: &[u8] = b"game";

/// Helper: read a [u8; 32] from a slice at a known offset.
/// Safe after from_bytes() has validated the minimum length.
fn read_pubkey(data: &[u8], offset: usize) -> &[u8; 32] {
    data[offset..offset + 32].try_into().unwrap()
}

/// Helper: read a u64 from a slice at a known offset (little-endian).
fn read_u64(data: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}

/// Helper: read a u16 from a slice at a known offset (little-endian).
fn read_u16(data: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(data[offset..offset + 2].try_into().unwrap())
}

/// Zero-copy wrapper over a GameSession account's byte slice.
///
/// # Safety contract
/// `from_bytes()` validates that `data.len() >= MIN_DATA_LEN` (394).
/// All accessors read at offsets <= 386+8 = 394, so they cannot
/// go out of bounds after that check. The `unwrap()` calls in helpers
/// are on fixed-size array conversions from slices whose length is
/// guaranteed by the constructor.
pub struct GameSession<'a> {
    data: &'a [u8],
}

/// Mutable zero-copy wrapper.
pub struct GameSessionMut<'a> {
    data: &'a mut [u8],
}

// Read-only accessors
impl<'a> GameSession<'a> {
    pub fn from_bytes(data: &'a [u8]) -> Self {
        assert!(
            data.len() >= MIN_DATA_LEN,
            "GameSession: data too short ({} < {})",
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

    pub fn game_id(&self) -> u64 {
        read_u64(self.data, GAME_ID)
    }

    pub fn authority(&self) -> &[u8; 32] {
        read_pubkey(self.data, AUTHORITY)
    }

    pub fn house(&self) -> &[u8; 32] {
        read_pubkey(self.data, HOUSE)
    }

    pub fn dealer(&self) -> &[u8; 32] {
        read_pubkey(self.data, DEALER)
    }

    pub fn treasury(&self) -> &[u8; 32] {
        read_pubkey(self.data, TREASURY)
    }

    pub fn token_mint(&self) -> &[u8; 32] {
        read_pubkey(self.data, TOKEN_MINT)
    }

    pub fn vault(&self) -> &[u8; 32] {
        read_pubkey(self.data, VAULT)
    }

    pub fn player_count(&self) -> u8 {
        self.data[PLAYER_COUNT]
    }

    pub fn turn_order_slot(&self, index: usize) -> &[u8; 32] {
        assert!(index < MAX_PLAYERS, "turn_order index out of bounds");
        let offset = TURN_ORDER + index * 32;
        read_pubkey(self.data, offset)
    }

    pub fn current_turn_index(&self) -> u8 {
        self.data[CURRENT_TURN_INDEX]
    }

    pub fn round_active(&self) -> bool {
        self.data[ROUND_ACTIVE] != 0
    }

    pub fn round_number(&self) -> u64 {
        read_u64(self.data, ROUND_NUMBER)
    }

    pub fn pot_amount(&self) -> u64 {
        read_u64(self.data, POT_AMOUNT)
    }

    pub fn merkle_root(&self) -> &[u8; 32] {
        read_pubkey(self.data, MERKLE_ROOT)
    }

    pub fn deck_committed(&self) -> bool {
        self.data[DECK_COMMITTED] != 0
    }

    pub fn draw_counter(&self) -> u8 {
        self.data[DRAW_COUNTER]
    }

    pub fn treasury_fee_bps(&self) -> u16 {
        read_u16(self.data, TREASURY_FEE_BPS)
    }

    pub fn rollover_count(&self) -> u8 {
        self.data[ROLLOVER_COUNT]
    }

    pub fn last_action_slot(&self) -> u64 {
        read_u64(self.data, LAST_ACTION_SLOT)
    }

    pub fn vault_bump(&self) -> u8 {
        self.data[VAULT_BUMP]
    }
}

// Mutable accessors
impl<'a> GameSessionMut<'a> {
    pub fn from_bytes(data: &'a mut [u8]) -> Self {
        assert!(
            data.len() >= MIN_DATA_LEN,
            "GameSessionMut: data too short ({} < {})",
            data.len(),
            MIN_DATA_LEN,
        );
        Self { data }
    }

    /// Read-only view of the same data.
    pub fn as_ref(&self) -> GameSession<'_> {
        GameSession { data: self.data }
    }

    pub fn set_discriminator(&mut self, val: u8) {
        self.data[DISCRIMINATOR] = val;
    }

    pub fn set_bump(&mut self, val: u8) {
        self.data[BUMP] = val;
    }

    pub fn set_game_id(&mut self, val: u64) {
        self.data[GAME_ID..GAME_ID + 8].copy_from_slice(&val.to_le_bytes());
    }

    pub fn set_authority(&mut self, val: &[u8; 32]) {
        self.data[AUTHORITY..AUTHORITY + 32].copy_from_slice(val);
    }

    pub fn set_house(&mut self, val: &[u8; 32]) {
        self.data[HOUSE..HOUSE + 32].copy_from_slice(val);
    }

    pub fn set_dealer(&mut self, val: &[u8; 32]) {
        self.data[DEALER..DEALER + 32].copy_from_slice(val);
    }

    pub fn set_treasury(&mut self, val: &[u8; 32]) {
        self.data[TREASURY..TREASURY + 32].copy_from_slice(val);
    }

    pub fn set_token_mint(&mut self, val: &[u8; 32]) {
        self.data[TOKEN_MINT..TOKEN_MINT + 32].copy_from_slice(val);
    }

    pub fn set_vault(&mut self, val: &[u8; 32]) {
        self.data[VAULT..VAULT + 32].copy_from_slice(val);
    }

    pub fn set_player_count(&mut self, val: u8) {
        self.data[PLAYER_COUNT] = val;
    }

    pub fn set_turn_order_slot(&mut self, index: usize, val: &[u8; 32]) {
        assert!(index < MAX_PLAYERS, "turn_order index out of bounds");
        let offset = TURN_ORDER + index * 32;
        self.data[offset..offset + 32].copy_from_slice(val);
    }

    pub fn set_current_turn_index(&mut self, val: u8) {
        self.data[CURRENT_TURN_INDEX] = val;
    }

    pub fn set_round_active(&mut self, val: bool) {
        self.data[ROUND_ACTIVE] = val as u8;
    }

    pub fn set_round_number(&mut self, val: u64) {
        self.data[ROUND_NUMBER..ROUND_NUMBER + 8].copy_from_slice(&val.to_le_bytes());
    }

    pub fn set_pot_amount(&mut self, val: u64) {
        self.data[POT_AMOUNT..POT_AMOUNT + 8].copy_from_slice(&val.to_le_bytes());
    }

    pub fn set_merkle_root(&mut self, val: &[u8; 32]) {
        self.data[MERKLE_ROOT..MERKLE_ROOT + 32].copy_from_slice(val);
    }

    pub fn set_deck_committed(&mut self, val: bool) {
        self.data[DECK_COMMITTED] = val as u8;
    }

    pub fn set_draw_counter(&mut self, val: u8) {
        self.data[DRAW_COUNTER] = val;
    }

    pub fn set_treasury_fee_bps(&mut self, val: u16) {
        self.data[TREASURY_FEE_BPS..TREASURY_FEE_BPS + 2].copy_from_slice(&val.to_le_bytes());
    }

    pub fn set_rollover_count(&mut self, val: u8) {
        self.data[ROLLOVER_COUNT] = val;
    }

    pub fn set_last_action_slot(&mut self, val: u64) {
        self.data[LAST_ACTION_SLOT..LAST_ACTION_SLOT + 8].copy_from_slice(&val.to_le_bytes());
    }

    pub fn set_vault_bump(&mut self, val: u8) {
        self.data[VAULT_BUMP] = val;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_game_session_roundtrip() {
        let mut buf = [0u8; GAME_SESSION_SIZE];
        let authority = [1u8; 32];
        let house = [2u8; 32];
        let dealer = [3u8; 32];

        {
            let mut gs = GameSessionMut::from_bytes(&mut buf);
            gs.set_discriminator(GAME_SESSION_DISCRIMINATOR);
            gs.set_bump(255);
            gs.set_game_id(42);
            gs.set_authority(&authority);
            gs.set_house(&house);
            gs.set_dealer(&dealer);
            gs.set_player_count(2);
            gs.set_round_active(true);
            gs.set_round_number(1);
            gs.set_pot_amount(1_000_000_000);
            gs.set_treasury_fee_bps(200);
            gs.set_deck_committed(false);
            gs.set_draw_counter(0);
            gs.set_rollover_count(3);
        }

        let gs = GameSession::from_bytes(&buf);
        assert_eq!(gs.discriminator(), GAME_SESSION_DISCRIMINATOR);
        assert_eq!(gs.bump(), 255);
        assert_eq!(gs.game_id(), 42);
        assert_eq!(gs.authority(), &authority);
        assert_eq!(gs.house(), &house);
        assert_eq!(gs.dealer(), &dealer);
        assert_eq!(gs.player_count(), 2);
        assert!(gs.round_active());
        assert_eq!(gs.round_number(), 1);
        assert_eq!(gs.pot_amount(), 1_000_000_000);
        assert_eq!(gs.treasury_fee_bps(), 200);
        assert!(!gs.deck_committed());
        assert_eq!(gs.draw_counter(), 0);
        assert_eq!(gs.rollover_count(), 3);
    }

    #[test]
    fn test_turn_order() {
        let mut buf = [0u8; GAME_SESSION_SIZE];
        let player1 = [10u8; 32];
        let player2 = [20u8; 32];

        let mut gs = GameSessionMut::from_bytes(&mut buf);
        gs.set_turn_order_slot(0, &player1);
        gs.set_turn_order_slot(1, &player2);

        let gs = GameSession::from_bytes(&buf);
        assert_eq!(gs.turn_order_slot(0), &player1);
        assert_eq!(gs.turn_order_slot(1), &player2);
    }

    #[test]
    #[should_panic(expected = "turn_order index out of bounds")]
    fn test_turn_order_out_of_bounds() {
        let buf = [0u8; GAME_SESSION_SIZE];
        let gs = GameSession::from_bytes(&buf);
        let _ = gs.turn_order_slot(4);
    }

    #[test]
    #[should_panic(expected = "data too short")]
    fn test_from_bytes_too_short() {
        let buf = [0u8; 10];
        let _ = GameSession::from_bytes(&buf);
    }

    #[test]
    fn test_layout_fits_in_allocation() {
        assert!(LAST_ACTION_SLOT + 8 <= GAME_SESSION_SIZE);
    }
}
