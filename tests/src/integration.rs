use litesvm::LiteSVM;
use solana_address::Address;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

fn program_id() -> Address {
    Address::from_str_const("HQLeAQc84WLz8buHM5JAJGBjNJjwc6Fpxts8jSMaW3px")
}

const SYSTEM_PROGRAM: Address = Address::from_str_const("11111111111111111111111111111111");
const TOKEN_PROGRAM: Address =
    Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const GAME_SEED: &[u8] = b"game";
const PLAYER_SEED: &[u8] = b"player";
const VAULT_SEED: &[u8] = b"vault";
const MIN_STAKE: u64 = 100_000_000_000;

const IX_INITIALIZE: u8 = 0;
const IX_COMMIT_DECK: u8 = 1;
const IX_JOIN_ROUND: u8 = 2;
const IX_CLOSE_GAME: u8 = 7;
const IX_LEAVE_GAME: u8 = 8;

fn setup() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new();
    // Path relative to tests/src/ → ../../target/deploy/pushflip.so
    svm.add_program(
        program_id(),
        include_bytes!("../../target/deploy/pushflip.so"),
    );
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();
    (svm, authority)
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

fn send_tx(svm: &mut LiteSVM, ix: Instruction, signers: &[&Keypair]) -> Result<(), String> {
    let msg = Message::new(&[ix], Some(&signers[0].pubkey()));
    let tx = Transaction::new(&signers.to_vec(), msg, svm.latest_blockhash());
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{e:?}"))
}

fn init_game(
    svm: &mut LiteSVM,
    authority: &Keypair,
    game_id: u64,
    dealer: &Address,
) -> (Address, u8) {
    let (pda, bump) = derive_game_pda(game_id);
    let (_vault_pda, vault_bump) =
        Address::find_program_address(&[VAULT_SEED, pda.as_ref()], &program_id());
    let mut data = vec![IX_INITIALIZE];
    data.extend_from_slice(&game_id.to_le_bytes());
    data.push(bump);
    data.push(vault_bump);
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(authority.pubkey(), true),
            AccountMeta::new(pda, false),
            AccountMeta::new_readonly(Address::new_unique(), false),
            AccountMeta::new_readonly(*dealer, false),
            AccountMeta::new_readonly(Address::new_unique(), false),
            AccountMeta::new_readonly(Address::new_unique(), false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
        ],
        data,
    };
    send_tx(svm, ix, &[authority]).unwrap();
    (pda, bump)
}

fn read_data(svm: &LiteSVM, addr: &Address) -> Vec<u8> {
    svm.get_account(addr).unwrap().data.clone()
}

// --- Tests ---

#[test]
fn test_initialize_game() {
    let (mut svm, authority) = setup();
    let game_id: u64 = 1;
    let (game_pda, bump) = init_game(&mut svm, &authority, game_id, &Address::new_unique());

    let d = read_data(&svm, &game_pda);
    assert_eq!(d[0], 1); // discriminator
    assert_eq!(d[1], bump);
    assert_eq!(u64::from_le_bytes(d[2..10].try_into().unwrap()), game_id);
    assert_eq!(d[202], 1); // player_count
    assert_eq!(d[332], 0); // round_active
    assert_eq!(d[381], 0); // deck_committed
}

#[test]
fn test_initialize_rejects_bad_fee() {
    let (mut svm, authority) = setup();
    let game_id: u64 = 2;
    let (pda, bump) = derive_game_pda(game_id);
    let (_vault_pda, vault_bump) =
        Address::find_program_address(&[VAULT_SEED, pda.as_ref()], &program_id());

    let mut data = vec![IX_INITIALIZE];
    data.extend_from_slice(&game_id.to_le_bytes());
    data.push(bump);
    data.push(vault_bump);
    data.extend_from_slice(&10000u16.to_le_bytes());

    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(authority.pubkey(), true),
            AccountMeta::new(pda, false),
            AccountMeta::new_readonly(Address::new_unique(), false),
            AccountMeta::new_readonly(Address::new_unique(), false),
            AccountMeta::new_readonly(Address::new_unique(), false),
            AccountMeta::new_readonly(Address::new_unique(), false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
        ],
        data,
    };
    assert!(send_tx(&mut svm, ix, &[&authority]).is_err());
}

fn build_join_data(bump: u8, stake: u64) -> Vec<u8> {
    let mut data = vec![IX_JOIN_ROUND, bump];
    data.extend_from_slice(&stake.to_le_bytes());
    data
}

fn join_round_ix(game_pda: &Address, ps: &Address, player: &Address, bump: u8) -> Instruction {
    // Derive the vault PDA to match what initialize stored
    let (vault_pda, _) =
        Address::find_program_address(&[VAULT_SEED, game_pda.as_ref()], &program_id());

    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(*game_pda, false),
            AccountMeta::new(*ps, false),
            AccountMeta::new(*player, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
            AccountMeta::new(Address::new_unique(), false), // player_token_account (dummy)
            AccountMeta::new(vault_pda, false),             // vault (correct PDA)
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
        ],
        data: build_join_data(bump, MIN_STAKE),
    }
}

#[test]
fn test_join_round() {
    let (mut svm, authority) = setup();
    let player1 = Keypair::new();
    svm.airdrop(&player1.pubkey(), 5_000_000_000).unwrap();

    let game_id: u64 = 10;
    let (game_pda, _) = init_game(&mut svm, &authority, game_id, &Address::new_unique());
    let (ps1, ps1_bump) = derive_player_pda(game_id, &player1.pubkey());

    send_tx(
        &mut svm,
        join_round_ix(&game_pda, &ps1, &player1.pubkey(), ps1_bump),
        &[&player1],
    )
    .unwrap();

    assert_eq!(read_data(&svm, &game_pda)[202], 2);
    let ps = read_data(&svm, &ps1);
    assert_eq!(ps[0], 2); // discriminator
    assert_eq!(ps[73], 1); // is_active
}

#[test]
fn test_duplicate_join_rejected() {
    let (mut svm, authority) = setup();
    let player1 = Keypair::new();
    svm.airdrop(&player1.pubkey(), 5_000_000_000).unwrap();

    let game_id: u64 = 11;
    let (game_pda, _) = init_game(&mut svm, &authority, game_id, &Address::new_unique());
    let (ps1, ps1_bump) = derive_player_pda(game_id, &player1.pubkey());

    send_tx(
        &mut svm,
        join_round_ix(&game_pda, &ps1, &player1.pubkey(), ps1_bump),
        &[&player1],
    )
    .unwrap();
    assert!(send_tx(
        &mut svm,
        join_round_ix(&game_pda, &ps1, &player1.pubkey(), ps1_bump),
        &[&player1]
    )
    .is_err());
}

#[test]
fn test_commit_deck() {
    let (mut svm, authority) = setup();
    let dealer = Keypair::new();
    svm.airdrop(&dealer.pubkey(), 5_000_000_000).unwrap();

    let game_id: u64 = 20;
    let (game_pda, _) = init_game(&mut svm, &authority, game_id, &dealer.pubkey());

    let root = [42u8; 32];
    let mut data = vec![IX_COMMIT_DECK];
    data.extend_from_slice(&root);
    data.extend_from_slice(&[0u8; 256]);

    send_tx(
        &mut svm,
        Instruction {
            program_id: program_id(),
            accounts: vec![
                AccountMeta::new(game_pda, false),
                AccountMeta::new_readonly(dealer.pubkey(), true),
            ],
            data,
        },
        &[&dealer],
    )
    .unwrap();

    let d = read_data(&svm, &game_pda);
    assert_eq!(d[381], 1);
    assert_eq!(&d[349..381], &root);
}

#[test]
fn test_commit_deck_wrong_dealer_rejected() {
    let (mut svm, authority) = setup();
    let dealer = Keypair::new();
    let fake = Keypair::new();
    svm.airdrop(&fake.pubkey(), 5_000_000_000).unwrap();

    let game_id: u64 = 21;
    let (game_pda, _) = init_game(&mut svm, &authority, game_id, &dealer.pubkey());

    let mut data = vec![IX_COMMIT_DECK];
    data.extend_from_slice(&[0u8; 288]);

    assert!(send_tx(
        &mut svm,
        Instruction {
            program_id: program_id(),
            accounts: vec![
                AccountMeta::new(game_pda, false),
                AccountMeta::new_readonly(fake.pubkey(), true),
            ],
            data,
        },
        &[&fake]
    )
    .is_err());
}

#[test]
fn test_leave_game_between_rounds() {
    let (mut svm, authority) = setup();
    let player1 = Keypair::new();
    svm.airdrop(&player1.pubkey(), 5_000_000_000).unwrap();

    let game_id: u64 = 40;
    let (game_pda, _) = init_game(&mut svm, &authority, game_id, &Address::new_unique());
    let (ps1, ps1_bump) = derive_player_pda(game_id, &player1.pubkey());

    send_tx(
        &mut svm,
        join_round_ix(&game_pda, &ps1, &player1.pubkey(), ps1_bump),
        &[&player1],
    )
    .unwrap();

    assert_eq!(read_data(&svm, &game_pda)[202], 2);

    send_tx(
        &mut svm,
        Instruction {
            program_id: program_id(),
            accounts: vec![
                AccountMeta::new(game_pda, false),
                AccountMeta::new(ps1, false),
                AccountMeta::new_readonly(player1.pubkey(), true),
                AccountMeta::new(player1.pubkey(), false),
            ],
            data: vec![IX_LEAVE_GAME],
        },
        &[&player1],
    )
    .unwrap();

    assert_eq!(read_data(&svm, &game_pda)[202], 1);
    assert!(svm.get_account(&ps1).is_none());
}

#[test]
fn test_close_game() {
    let (mut svm, authority) = setup();
    let game_id: u64 = 50;
    let (game_pda, _) = init_game(&mut svm, &authority, game_id, &Address::new_unique());

    send_tx(
        &mut svm,
        Instruction {
            program_id: program_id(),
            accounts: vec![
                AccountMeta::new(game_pda, false),
                AccountMeta::new_readonly(authority.pubkey(), true),
                AccountMeta::new(authority.pubkey(), false),
            ],
            data: vec![IX_CLOSE_GAME],
        },
        &[&authority],
    )
    .unwrap();

    let acct = svm.get_account(&game_pda);
    assert!(acct.is_none() || acct.unwrap().lamports == 0);
}

#[test]
fn test_close_game_wrong_authority_rejected() {
    let (mut svm, authority) = setup();
    let attacker = Keypair::new();
    svm.airdrop(&attacker.pubkey(), 5_000_000_000).unwrap();

    let game_id: u64 = 51;
    let (game_pda, _) = init_game(&mut svm, &authority, game_id, &Address::new_unique());

    assert!(send_tx(
        &mut svm,
        Instruction {
            program_id: program_id(),
            accounts: vec![
                AccountMeta::new(game_pda, false),
                AccountMeta::new_readonly(attacker.pubkey(), true),
                AccountMeta::new(attacker.pubkey(), false),
            ],
            data: vec![IX_CLOSE_GAME],
        },
        &[&attacker]
    )
    .is_err());
}
