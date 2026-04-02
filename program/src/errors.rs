use pinocchio::error::ProgramError;

#[derive(Clone, Debug, PartialEq)]
pub enum PushFlipError {
    InvalidInstruction,
    GameAlreadyInitialized,
    GameNotFound,
    RoundAlreadyActive,
    RoundNotActive,
    DeckNotCommitted,
    DeckAlreadyCommitted,
    NotYourTurn,
    PlayerNotActive,
    MaxPlayersReached,
    PlayerAlreadyJoined,
    InvalidMerkleProof,
    InvalidGroth16Proof,
    InsufficientStake,
    InvalidAccountOwner,
    InvalidPda,
    MissingSigner,
    MissingWritable,
    SecondChanceAlreadyUsed,
    NotBusted,
    InvalidDealerSigner,
    InvalidCardIndex,
    ArithmeticOverflow,
    InvalidTreasuryFeeBps,
    PlayerStateMismatch,
    PlayersStillActive,
    PotNotEmpty,
    InvalidTurnIndex,
    LeafIndexOutOfRange,
}

impl From<PushFlipError> for ProgramError {
    fn from(e: PushFlipError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
