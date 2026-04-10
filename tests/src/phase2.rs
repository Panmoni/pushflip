/// Phase 2 integration tests — token flows, burn mechanics, protocol cards.
///
/// These tests exercise the SPL Token integration: staking on join,
/// prize distribution on end_round, and token burns for second chance / scry.
use litesvm::LiteSVM;
use solana_address::Address;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_program_pack::Pack;
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_token_interface::state::{Account as TokenAccount, AccountState, Mint};

fn program_id() -> Address {
    Address::from_str_const("HQLeAQc84WLz8buHM5JAJGBjNJjwc6Fpxts8jSMaW3px")
}

const SYSTEM_PROGRAM: Address = Address::from_str_const("11111111111111111111111111111111");
const TOKEN_PROGRAM: Address =
    Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const GAME_SEED: &[u8] = b"game";
const PLAYER_SEED: &[u8] = b"player";
const VAULT_SEED: &[u8] = b"vault";

const IX_INITIALIZE: u8 = 0;
const IX_COMMIT_DECK: u8 = 1;
const IX_JOIN_ROUND: u8 = 2;
const IX_START_ROUND: u8 = 3;
const IX_HIT: u8 = 4;
const IX_STAY: u8 = 5;
const IX_END_ROUND: u8 = 6;
const IX_BURN_SECOND_CHANCE: u8 = 9;
const IX_BURN_SCRY: u8 = 10;

const MIN_STAKE: u64 = 100_000_000_000; // 100 $FLIP
const INITIAL_SUPPLY: u64 = 10_000_000_000_000; // 10,000 $FLIP

fn setup() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new();
    // `PUSHFLIP_TEST_SBF_PATH` is exported by `tests/build.rs`; see
    // integration.rs for the full rationale.
    let _ = svm.add_program(program_id(), include_bytes!(env!("PUSHFLIP_TEST_SBF_PATH")));
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 50_000_000_000).unwrap();
    (svm, authority)
}

fn send_tx(svm: &mut LiteSVM, ix: Instruction, signers: &[&Keypair]) -> Result<(), String> {
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&signers[0].pubkey()),
        signers,
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{e:?}"))
}

fn send_txs(svm: &mut LiteSVM, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
    let tx = Transaction::new_signed_with_payer(
        ixs,
        Some(&signers[0].pubkey()),
        signers,
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{e:?}"))
}

fn derive_game_pda(game_id: u64) -> (Address, u8) {
    Address::find_program_address(&[GAME_SEED, &game_id.to_le_bytes()], &program_id())
}

fn derive_player_pda(game_id: u64, player: &Address) -> (Address, u8) {
    Address::find_program_address(
        &[PLAYER_SEED, &game_id.to_le_bytes(), player.as_ref()],
        &program_id(),
    )
}

fn derive_vault_pda(game_pda: &Address) -> (Address, u8) {
    Address::find_program_address(&[VAULT_SEED, game_pda.as_ref()], &program_id())
}

fn read_data(svm: &LiteSVM, addr: &Address) -> Vec<u8> {
    svm.get_account(addr).unwrap().data.clone()
}

/// Create an SPL Token mint and return the mint address.
fn create_mint(svm: &mut LiteSVM, payer: &Keypair, mint_authority: &Address) -> Address {
    let mint_kp = Keypair::new();
    let mint_pk = mint_kp.pubkey();

    let create_ix = solana_system_interface::instruction::create_account(
        &payer.pubkey(),
        &mint_pk,
        svm.minimum_balance_for_rent_exemption(Mint::LEN),
        Mint::LEN as u64,
        &TOKEN_PROGRAM,
    );
    let init_ix = spl_token_interface::instruction::initialize_mint2(
        &TOKEN_PROGRAM,
        &mint_pk,
        mint_authority,
        None,
        9, // FLIP_DECIMALS
    )
    .unwrap();

    send_txs(svm, &[create_ix, init_ix], &[payer, &mint_kp]).unwrap();
    mint_pk
}

/// Create an associated token account and return its address.
fn create_token_account(
    svm: &mut LiteSVM,
    payer: &Keypair,
    mint: &Address,
    owner: &Address,
) -> Address {
    let ata =
        spl_associated_token_account_interface::address::get_associated_token_address(owner, mint);

    let create_ix =
        spl_associated_token_account_interface::instruction::create_associated_token_account_idempotent(
            &payer.pubkey(),
            owner,
            mint,
            &TOKEN_PROGRAM,
        );
    send_tx(svm, create_ix, &[payer]).unwrap();
    ata
}

/// Create a token account at an arbitrary address (e.g. a PDA).
/// Uses LiteSVM's set_account to place a properly formatted SPL token account.
fn create_token_account_at(svm: &mut LiteSVM, address: &Address, mint: &Address, owner: &Address) {
    let token_acc = TokenAccount {
        mint: *mint,
        owner: *owner,
        amount: 0,
        delegate: None.into(),
        state: AccountState::Initialized,
        is_native: None.into(),
        delegated_amount: 0,
        close_authority: None.into(),
    };
    let mut data = [0u8; TokenAccount::LEN];
    TokenAccount::pack(token_acc, &mut data).unwrap();

    let rent = svm.minimum_balance_for_rent_exemption(TokenAccount::LEN);
    svm.set_account(
        *address,
        solana_account::Account {
            lamports: rent,
            data: data.to_vec(),
            owner: TOKEN_PROGRAM,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

/// Mint tokens to an account.
fn mint_to(
    svm: &mut LiteSVM,
    payer: &Keypair,
    mint: &Address,
    dest: &Address,
    authority: &Keypair,
    amount: u64,
) {
    let ix = spl_token_interface::instruction::mint_to(
        &TOKEN_PROGRAM,
        mint,
        dest,
        &authority.pubkey(),
        &[],
        amount,
    )
    .unwrap();
    send_tx(svm, ix, &[payer, authority]).unwrap();
}

/// Read token account balance.
fn token_balance(svm: &LiteSVM, account: &Address) -> u64 {
    let acct = svm.get_account(account).unwrap();
    TokenAccount::unpack(&acct.data).unwrap().amount
}

/// Initialize a game with SPL token infrastructure.
struct TestGame {
    game_pda: Address,
    game_bump: u8,
    vault_pda: Address,
    vault_bump: u8,
    mint: Address,
    treasury_ata: Address,
    game_id: u64,
}

fn init_game_with_tokens(
    svm: &mut LiteSVM,
    authority: &Keypair,
    game_id: u64,
    dealer: &Address,
) -> TestGame {
    let (game_pda, game_bump) = derive_game_pda(game_id);
    let (vault_pda, vault_bump) = derive_vault_pda(&game_pda);

    // Create SPL Token mint
    let mint = create_mint(svm, authority, &authority.pubkey());

    // Create treasury ATA
    let treasury = Keypair::new();
    svm.airdrop(&treasury.pubkey(), 1_000_000_000).unwrap();
    let treasury_ata = create_token_account(svm, authority, &mint, &treasury.pubkey());

    // Create token account at the vault PDA address (owned by vault PDA itself)
    create_token_account_at(svm, &vault_pda, &mint, &vault_pda);

    // House AI wallet (just a placeholder address for tests)
    let house = Address::new_unique();

    // Initialize the game
    // Accounts: authority, game_session, house, dealer, treasury, token_mint, system_program
    let mut data = vec![IX_INITIALIZE];
    data.extend_from_slice(&game_id.to_le_bytes());
    data.push(game_bump);
    data.push(vault_bump);

    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(authority.pubkey(), true), // 0: authority
            AccountMeta::new(game_pda, false),          // 1: game_session PDA
            AccountMeta::new_readonly(house, false),    // 2: house AI wallet
            AccountMeta::new_readonly(*dealer, false),  // 3: dealer
            AccountMeta::new_readonly(treasury.pubkey(), false), // 4: treasury wallet
            AccountMeta::new_readonly(mint, false),     // 5: token_mint
            AccountMeta::new_readonly(SYSTEM_PROGRAM, false), // 6: system_program
        ],
        data,
    };
    send_tx(svm, ix, &[authority]).unwrap();

    TestGame {
        game_pda,
        game_bump,
        vault_pda,
        vault_bump,
        mint,
        treasury_ata,
        game_id,
    }
}

/// Fund a player with SOL and $FLIP, then join the game.
fn join_game(
    svm: &mut LiteSVM,
    authority: &Keypair,
    game: &TestGame,
    player: &Keypair,
    stake: u64,
) -> (Address, Address, u8) {
    // Airdrop SOL
    svm.airdrop(&player.pubkey(), 5_000_000_000).unwrap();

    // Create player's token account and mint FLIP
    let player_ata = create_token_account(svm, authority, &game.mint, &player.pubkey());
    mint_to(
        svm,
        authority,
        &game.mint,
        &player_ata,
        authority,
        stake * 5,
    ); // give 5x stake

    let (ps_pda, ps_bump) = derive_player_pda(game.game_id, &player.pubkey());

    // Derive vault ATA
    // Vault token account lives at the vault PDA address itself
    let vault_ata = game.vault_pda;

    let mut data = vec![IX_JOIN_ROUND, ps_bump];
    data.extend_from_slice(&stake.to_le_bytes());

    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(game.game_pda, false),
            AccountMeta::new(ps_pda, false),
            AccountMeta::new(player.pubkey(), true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
            AccountMeta::new(player_ata, false),
            AccountMeta::new(vault_ata, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
        ],
        data,
    };
    send_tx(svm, ix, &[player]).unwrap();

    (ps_pda, player_ata, ps_bump)
}

fn commit_deck(svm: &mut LiteSVM, game: &TestGame, dealer: &Keypair) {
    let root = [42u8; 32];
    let mut data = vec![IX_COMMIT_DECK];
    data.extend_from_slice(&root);
    data.extend_from_slice(&[0u8; 256]); // placeholder proof

    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(game.game_pda, false),
            AccountMeta::new_readonly(dealer.pubkey(), true),
        ],
        data,
    };
    send_tx(svm, ix, &[dealer]).unwrap();
}

fn start_round(svm: &mut LiteSVM, authority: &Keypair, game: &TestGame, player_states: &[Address]) {
    let mut accounts = vec![
        AccountMeta::new(game.game_pda, false),
        AccountMeta::new_readonly(authority.pubkey(), true),
    ];
    for ps in player_states {
        accounts.push(AccountMeta::new(*ps, false));
    }

    let ix = Instruction {
        program_id: program_id(),
        accounts,
        data: vec![IX_START_ROUND],
    };
    send_tx(svm, ix, &[authority]).unwrap();
}

// --- Token Flow Tests (2.9.1) ---

#[test]
fn test_join_with_stake_transfers_tokens() {
    let (mut svm, authority) = setup();
    let dealer = Keypair::new();
    let game = init_game_with_tokens(&mut svm, &authority, 100, &dealer.pubkey());
    let player = Keypair::new();

    // Vault token account lives at the vault PDA address itself
    let vault_ata = game.vault_pda;

    let (_, player_ata, _) = join_game(&mut svm, &authority, &game, &player, MIN_STAKE);

    // Verify tokens moved from player to vault
    let player_balance = token_balance(&svm, &player_ata);
    let vault_balance = token_balance(&svm, &vault_ata);

    assert_eq!(
        vault_balance, MIN_STAKE,
        "Vault should have exactly the staked amount"
    );
    assert_eq!(
        player_balance,
        MIN_STAKE * 5 - MIN_STAKE,
        "Player should have initial - stake"
    );
}

#[test]
fn test_full_round_with_prize_distribution() {
    let (mut svm, authority) = setup();
    let dealer = Keypair::new();
    svm.airdrop(&dealer.pubkey(), 5_000_000_000).unwrap();

    let game = init_game_with_tokens(&mut svm, &authority, 101, &dealer.pubkey());

    // Two real players legitimately join — turn_order = [player1, player2]
    let player1 = Keypair::new();
    let player2 = Keypair::new();
    let (ps1, p1_ata, _) = join_game(&mut svm, &authority, &game, &player1, MIN_STAKE);
    let (ps2, _p2_ata, _) = join_game(&mut svm, &authority, &game, &player2, MIN_STAKE);

    // Commit deck and start round
    commit_deck(&mut svm, &game, &dealer);
    start_round(&mut svm, &authority, &game, &[ps1, ps2]);

    // Both players stay in turn order — current_turn_index advances naturally
    for (player, ps) in [(&player1, &ps1), (&player2, &ps2)] {
        let ix = Instruction {
            program_id: program_id(),
            accounts: vec![
                AccountMeta::new(game.game_pda, false),
                AccountMeta::new(*ps, false),
                AccountMeta::new_readonly(player.pubkey(), true),
            ],
            data: vec![IX_STAY],
        };
        send_tx(&mut svm, ix, &[player]).unwrap();
    }

    // Vault token account lives at the vault PDA address itself
    let vault_ata = game.vault_pda;

    let vault_before = token_balance(&svm, &vault_ata);
    assert_eq!(vault_before, MIN_STAKE * 2, "Vault should have both stakes");

    // End round — winner gets pot minus rake
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(game.game_pda, false),
            AccountMeta::new_readonly(authority.pubkey(), true),
            AccountMeta::new(vault_ata, false),
            AccountMeta::new(p1_ata, false), // winner (first player with equal score)
            AccountMeta::new(game.treasury_ata, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(ps1, false),
            AccountMeta::new_readonly(ps2, false),
        ],
        data: vec![IX_END_ROUND],
    };
    send_tx(&mut svm, ix, &[&authority]).unwrap();

    // Verify prize distribution
    let vault_after = token_balance(&svm, &vault_ata);
    let p1_after = token_balance(&svm, &p1_ata);
    let treasury_after = token_balance(&svm, &game.treasury_ata);

    // Vault should be empty (all distributed)
    assert_eq!(vault_after, 0, "Vault should be empty after payout");

    // Total distributed should equal pot
    let total_pot = MIN_STAKE * 2;
    assert_eq!(
        p1_after - (MIN_STAKE * 5 - MIN_STAKE) + treasury_after,
        total_pot,
        "Winner payout + rake should equal total pot"
    );

    // Treasury should have gotten the rake (default 200 bps = 2%)
    let expected_rake = total_pot * 200 / 10_000;
    assert_eq!(
        treasury_after, expected_rake,
        "Treasury should receive 2% rake"
    );
}

#[test]
fn test_vault_empty_after_payout() {
    let (mut svm, authority) = setup();
    let dealer = Keypair::new();
    svm.airdrop(&dealer.pubkey(), 5_000_000_000).unwrap();

    let game = init_game_with_tokens(&mut svm, &authority, 102, &dealer.pubkey());

    let player1 = Keypair::new();
    let player2 = Keypair::new();
    let (ps1, p1_ata, _) = join_game(&mut svm, &authority, &game, &player1, MIN_STAKE);
    let (ps2, _, _) = join_game(&mut svm, &authority, &game, &player2, MIN_STAKE);

    commit_deck(&mut svm, &game, &dealer);
    start_round(&mut svm, &authority, &game, &[ps1, ps2]);

    for (player, ps) in [(&player1, &ps1), (&player2, &ps2)] {
        let ix = Instruction {
            program_id: program_id(),
            accounts: vec![
                AccountMeta::new(game.game_pda, false),
                AccountMeta::new(*ps, false),
                AccountMeta::new_readonly(player.pubkey(), true),
            ],
            data: vec![IX_STAY],
        };
        send_tx(&mut svm, ix, &[player]).unwrap();
    }

    let vault_ata = game.vault_pda;

    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(game.game_pda, false),
            AccountMeta::new_readonly(authority.pubkey(), true),
            AccountMeta::new(vault_ata, false),
            AccountMeta::new(p1_ata, false),
            AccountMeta::new(game.treasury_ata, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(ps1, false),
            AccountMeta::new_readonly(ps2, false),
        ],
        data: vec![IX_END_ROUND],
    };
    send_tx(&mut svm, ix, &[&authority]).unwrap();

    let vault_balance = token_balance(&svm, &vault_ata);
    assert_eq!(vault_balance, 0, "Vault must be empty after end_round");
}

// --- Burn Mechanics Tests (2.9.2) ---

const SECOND_CHANCE_COST: u64 = 50_000_000_000;
const SCRY_COST: u64 = 25_000_000_000;

/// Helper: set up a game with an active round and a player in a given state.
///
/// Two ephemeral players both legitimately join via `join_round` (no state
/// injection for the House — initialize no longer auto-adds it). After
/// `start_round`, current_turn_index = 0 (player A's turn).
///
/// If `player_a_is_bust` is true, player A's state is injected into BUST.
/// LiteSVM tests still need this shortcut because making a real bust would
/// require generating a real Groth16 proof and Merkle proofs, which is the
/// dealer's job and out of scope for these unit-level tests.
///
/// Returns (game, player_a_keypair, ps_a_pda, p_a_ata, ps_b_pda).
fn setup_round_with_player(
    svm: &mut LiteSVM,
    authority: &Keypair,
    game_id: u64,
    player_a_is_bust: bool,
) -> (TestGame, Keypair, Address, Address, Address) {
    let dealer = Keypair::new();
    svm.airdrop(&dealer.pubkey(), 5_000_000_000).unwrap();

    let game = init_game_with_tokens(svm, authority, game_id, &dealer.pubkey());

    // Two real players both join via the legitimate path
    let player_a = Keypair::new();
    let player_b = Keypair::new();
    let (ps_a, p_a_ata, _) = join_game(svm, authority, &game, &player_a, MIN_STAKE);
    let (ps_b, _p_b_ata, _) = join_game(svm, authority, &game, &player_b, MIN_STAKE);

    // Commit deck and start round — current_turn_index will be 0 (player A)
    commit_deck(svm, &game, &dealer);
    start_round(svm, authority, &game, &[ps_a, ps_b]);

    if player_a_is_bust {
        // Simulate bust: inject player A's state. burn_second_chance only
        // checks `inactive_reason == BUST`, not turn order, so we can do
        // this without touching current_turn_index.
        let mut ps_data = svm.get_account(&ps_a).unwrap().data.clone();
        ps_data[42] = 1; // hand_size = 1
        ps_data[43] = 13; // card value = King (13)
        ps_data[44] = 0; // card_type = ALPHA
        ps_data[45] = 0; // suit = 0
        ps_data[73] = 0; // is_active = false
        ps_data[74] = 1; // inactive_reason = BUST
        ps_data[75] = 13; // bust_card_value = 13
        let rent = svm.minimum_balance_for_rent_exemption(ps_data.len());
        svm.set_account(
            ps_a,
            solana_account::Account {
                lamports: rent,
                data: ps_data,
                owner: program_id(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    }

    (game, player_a, ps_a, p_a_ata, ps_b)
}

#[test]
fn test_burn_second_chance_recovers_from_bust() {
    let (mut svm, authority) = setup();
    let (game, player, ps, p_ata, _ps_b) = setup_round_with_player(&mut svm, &authority, 200, true);

    let balance_before = token_balance(&svm, &p_ata);

    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(game.game_pda, false),
            AccountMeta::new(ps, false),
            AccountMeta::new_readonly(player.pubkey(), true),
            AccountMeta::new(p_ata, false),
            AccountMeta::new(game.mint, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
        ],
        data: vec![IX_BURN_SECOND_CHANCE],
    };
    send_tx(&mut svm, ix, &[&player]).unwrap();

    // Verify tokens burned
    let balance_after = token_balance(&svm, &p_ata);
    assert_eq!(
        balance_before - balance_after,
        SECOND_CHANCE_COST,
        "Should burn 50 $FLIP"
    );

    // Verify player is active again
    let ps_data = read_data(&svm, &ps);
    assert_eq!(
        ps_data[73], 1,
        "Player should be active after second chance"
    );
    assert_eq!(ps_data[74], 0, "Inactive reason should be ACTIVE");
    assert_eq!(ps_data[75], 0, "Bust card value should be cleared");
    assert_eq!(ps_data[42], 0, "Hand size should be 0 (bust card removed)");
    assert_eq!(ps_data[92], 1, "has_used_second_chance should be true");
}

#[test]
fn test_burn_second_chance_rejects_non_busted() {
    let (mut svm, authority) = setup();
    let (game, player, ps, p_ata, _ps_b) =
        setup_round_with_player(&mut svm, &authority, 201, false);

    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(game.game_pda, false),
            AccountMeta::new(ps, false),
            AccountMeta::new_readonly(player.pubkey(), true),
            AccountMeta::new(p_ata, false),
            AccountMeta::new(game.mint, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
        ],
        data: vec![IX_BURN_SECOND_CHANCE],
    };
    assert!(
        send_tx(&mut svm, ix, &[&player]).is_err(),
        "Non-busted player should not be able to use second chance"
    );
}

#[test]
fn test_burn_second_chance_rejects_double_use() {
    let (mut svm, authority) = setup();
    let (game, player, ps, p_ata, _ps_b) = setup_round_with_player(&mut svm, &authority, 202, true);

    // First use succeeds
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(game.game_pda, false),
            AccountMeta::new(ps, false),
            AccountMeta::new_readonly(player.pubkey(), true),
            AccountMeta::new(p_ata, false),
            AccountMeta::new(game.mint, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
        ],
        data: vec![IX_BURN_SECOND_CHANCE],
    };
    send_tx(&mut svm, ix.clone(), &[&player]).unwrap();

    // Simulate bust again
    {
        let mut ps_data = svm.get_account(&ps).unwrap().data.clone();
        ps_data[73] = 0; // is_active = false
        ps_data[74] = 1; // BUST
        ps_data[75] = 10; // bust_card_value
        ps_data[42] = 1; // hand_size = 1
        svm.set_account(
            ps,
            solana_account::Account {
                lamports: svm.minimum_balance_for_rent_exemption(ps_data.len()),
                data: ps_data,
                owner: program_id(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    }

    // Second use should fail
    assert!(
        send_tx(&mut svm, ix, &[&player]).is_err(),
        "Second chance should only be usable once"
    );
}

#[test]
fn test_burn_scry_burns_tokens() {
    let (mut svm, authority) = setup();
    let (game, player, ps, p_ata, _ps_b) =
        setup_round_with_player(&mut svm, &authority, 210, false);

    let balance_before = token_balance(&svm, &p_ata);

    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(game.game_pda, false),
            AccountMeta::new(ps, false),
            AccountMeta::new_readonly(player.pubkey(), true),
            AccountMeta::new(p_ata, false),
            AccountMeta::new(game.mint, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
        ],
        data: vec![IX_BURN_SCRY],
    };
    send_tx(&mut svm, ix, &[&player]).unwrap();

    let balance_after = token_balance(&svm, &p_ata);
    assert_eq!(
        balance_before - balance_after,
        SCRY_COST,
        "Should burn 25 $FLIP"
    );

    // Verify scry flag set
    let ps_data = read_data(&svm, &ps);
    assert_eq!(ps_data[93], 1, "has_used_scry should be true");
    // Player should still be active
    assert_eq!(ps_data[73], 1, "Player should remain active after scry");
}

#[test]
fn test_burn_scry_rejects_double_use() {
    let (mut svm, authority) = setup();
    let (game, player, ps, p_ata, _ps_b) =
        setup_round_with_player(&mut svm, &authority, 211, false);

    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(game.game_pda, false),
            AccountMeta::new(ps, false),
            AccountMeta::new_readonly(player.pubkey(), true),
            AccountMeta::new(p_ata, false),
            AccountMeta::new(game.mint, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
        ],
        data: vec![IX_BURN_SCRY],
    };
    send_tx(&mut svm, ix.clone(), &[&player]).unwrap();

    // Second scry should fail
    assert!(
        send_tx(&mut svm, ix, &[&player]).is_err(),
        "Scry should only be usable once per round"
    );
}

#[test]
fn test_token_supply_decreases_after_burns() {
    let (mut svm, authority) = setup();
    let (game, player, ps, p_ata, _ps_b) = setup_round_with_player(&mut svm, &authority, 220, true);

    // Read supply before
    let mint_data = svm.get_account(&game.mint).unwrap();
    let mint_before = Mint::unpack(&mint_data.data).unwrap();
    let supply_before = mint_before.supply;

    // Burn second chance (50 $FLIP)
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(game.game_pda, false),
            AccountMeta::new(ps, false),
            AccountMeta::new_readonly(player.pubkey(), true),
            AccountMeta::new(p_ata, false),
            AccountMeta::new(game.mint, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
        ],
        data: vec![IX_BURN_SECOND_CHANCE],
    };
    send_tx(&mut svm, ix, &[&player]).unwrap();

    // Read supply after
    let mint_data = svm.get_account(&game.mint).unwrap();
    let mint_after = Mint::unpack(&mint_data.data).unwrap();

    assert_eq!(
        supply_before - mint_after.supply,
        SECOND_CHANCE_COST,
        "Total token supply should decrease by burn amount"
    );
}

// --- Protocol Cards & Bounty Tests (2.9.3) ---

const BOUNTY_BOARD_DISCRIMINATOR: u8 = 3;
const BOUNTY_BOARD_SIZE: usize = 1500;
const BOUNTY_SEED: &[u8] = b"bounty";
const BOUNTY_SIZE: usize = 42;

#[test]
fn test_bounty_board_state_structure() {
    // Verify the bounty board PDA can be created and populated
    let (mut svm, authority) = setup();
    let game_id: u64 = 300;
    let (game_pda, _) = derive_game_pda(game_id);

    // Derive bounty board PDA
    let (bounty_pda, bounty_bump) =
        Address::find_program_address(&[BOUNTY_SEED, game_pda.as_ref()], &program_id());

    // Create bounty board account manually (state-only system)
    let mut data = vec![0u8; BOUNTY_BOARD_SIZE];
    data[0] = BOUNTY_BOARD_DISCRIMINATOR;
    data[1] = bounty_bump;
    data[2..34].copy_from_slice(game_pda.as_ref()); // game_session
    data[34] = 2; // bounty_count = 2

    // Bounty 0: SEVEN_CARD_WIN, reward=1000 $FLIP, active
    let b0 = 35;
    data[b0] = 0; // SEVEN_CARD_WIN
    data[b0 + 1..b0 + 9].copy_from_slice(&1_000_000_000_000u64.to_le_bytes());
    data[b0 + 9] = 1; // is_active

    // Bounty 1: HIGH_SCORE, reward=500 $FLIP, active
    let b1 = 35 + BOUNTY_SIZE;
    data[b1] = 1; // HIGH_SCORE
    data[b1 + 1..b1 + 9].copy_from_slice(&500_000_000_000u64.to_le_bytes());
    data[b1 + 9] = 1; // is_active

    let rent = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(
        bounty_pda,
        solana_account::Account {
            lamports: rent,
            data: data.clone(),
            owner: program_id(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    // Verify we can read it back
    let stored = read_data(&svm, &bounty_pda);
    assert_eq!(stored[0], BOUNTY_BOARD_DISCRIMINATOR);
    assert_eq!(stored[34], 2); // bounty_count
    assert_eq!(stored[35], 0); // bounty 0 type = SEVEN_CARD_WIN
    assert_eq!(stored[35 + 9], 1); // bounty 0 is_active
    assert_eq!(stored[35 + BOUNTY_SIZE], 1); // bounty 1 type = HIGH_SCORE
}

#[test]
fn test_full_game_lifecycle_with_all_mechanics() {
    // Integration test: init → join (with stake) → commit → start → stay → end
    // Verifies the entire Phase 2 flow end-to-end.
    let (mut svm, authority) = setup();
    let dealer = Keypair::new();
    svm.airdrop(&dealer.pubkey(), 5_000_000_000).unwrap();

    let game = init_game_with_tokens(&mut svm, &authority, 301, &dealer.pubkey());

    // Two players join with stakes — turn_order = [player1, player2]
    let player1 = Keypair::new();
    let player2 = Keypair::new();
    let (ps1, p1_ata, _) = join_game(&mut svm, &authority, &game, &player1, MIN_STAKE);
    let (ps2, _p2_ata, _) = join_game(&mut svm, &authority, &game, &player2, MIN_STAKE);

    // Verify pot
    let gs_data = read_data(&svm, &game.game_pda);
    let pot = u64::from_le_bytes(gs_data[341..349].try_into().unwrap());
    assert_eq!(pot, MIN_STAKE * 2, "Pot should be sum of both stakes");

    // Commit and start
    commit_deck(&mut svm, &game, &dealer);
    start_round(&mut svm, &authority, &game, &[ps1, ps2]);

    // Verify round is active
    let gs_data = read_data(&svm, &game.game_pda);
    assert_eq!(gs_data[332], 1, "round_active should be true");
    assert_eq!(gs_data[333], 1, "round_number should be 1");

    // Player1 stays
    send_tx(
        &mut svm,
        Instruction {
            program_id: program_id(),
            accounts: vec![
                AccountMeta::new(game.game_pda, false),
                AccountMeta::new(ps1, false),
                AccountMeta::new_readonly(player1.pubkey(), true),
            ],
            data: vec![IX_STAY],
        },
        &[&player1],
    )
    .unwrap();

    // Player2 stays
    send_tx(
        &mut svm,
        Instruction {
            program_id: program_id(),
            accounts: vec![
                AccountMeta::new(game.game_pda, false),
                AccountMeta::new(ps2, false),
                AccountMeta::new_readonly(player2.pubkey(), true),
            ],
            data: vec![IX_STAY],
        },
        &[&player2],
    )
    .unwrap();

    // End round
    let vault_ata = game.vault_pda;
    send_tx(
        &mut svm,
        Instruction {
            program_id: program_id(),
            accounts: vec![
                AccountMeta::new(game.game_pda, false),
                AccountMeta::new_readonly(authority.pubkey(), true),
                AccountMeta::new(vault_ata, false),
                AccountMeta::new(p1_ata, false),
                AccountMeta::new(game.treasury_ata, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM, false),
                AccountMeta::new_readonly(ps1, false),
                AccountMeta::new_readonly(ps2, false),
            ],
            data: vec![IX_END_ROUND],
        },
        &[&authority],
    )
    .unwrap();

    // Verify final state
    let gs_data = read_data(&svm, &game.game_pda);
    assert_eq!(gs_data[332], 0, "round_active should be false");
    assert_eq!(gs_data[381], 0, "deck_committed should be false");
    let pot_after = u64::from_le_bytes(gs_data[341..349].try_into().unwrap());
    assert_eq!(pot_after, 0, "Pot should be 0 after payout");

    // Vault should be empty
    assert_eq!(token_balance(&svm, &vault_ata), 0);

    // Treasury should have received rake
    let treasury_balance = token_balance(&svm, &game.treasury_ata);
    assert!(treasury_balance > 0, "Treasury should have received rake");
}
