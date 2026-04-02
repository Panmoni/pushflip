/// $FLIP token decimals (same convention as SOL: 1 $FLIP = 1_000_000_000)
pub const FLIP_DECIMALS: u8 = 9;

/// Minimum stake to join a round (100 $FLIP)
pub const MIN_STAKE: u64 = 100_000_000_000;

/// House's mandatory stake per round (500 $FLIP)
pub const HOUSE_STAKE_AMOUNT: u64 = 500_000_000_000;

/// Cost to burn for Second Chance ability (50 $FLIP)
pub const SECOND_CHANCE_COST: u64 = 50_000_000_000;

/// Cost to burn for Scry ability (25 $FLIP)
pub const SCRY_COST: u64 = 25_000_000_000;

/// Bonus tokens from Airdrop protocol card (25 $FLIP)
pub const AIRDROP_BONUS: u64 = 25_000_000_000;

/// Default treasury fee in basis points (200 = 2%)
pub const DEFAULT_TREASURY_FEE_BPS: u16 = 200;

/// Vault PDA seed prefix
pub const VAULT_SEED: &[u8] = b"vault";
