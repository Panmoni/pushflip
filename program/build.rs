//! Build script for the pushflip on-chain program.
//!
//! This script's only job is to make `--features skip-zk-verify` *loud*.
//! That feature flag short-circuits Groth16 verification in `commit_deck`,
//! which is essential for fast LiteSVM tests but catastrophic if it ever
//! ships in a production deploy.
//!
//! See heavy-duty review pass 4 (Task 3.A.5) finding C1 / discussion of
//! the CRITICAL skip-zk-verify bypass risk for the full rationale.
//!
//! ## Defense-in-depth model
//!
//! The repo has FOUR layers of protection against accidental deploy of a
//! `skip-zk-verify` binary to mainnet:
//!
//!   1. **Different on-disk paths** (most important). The test binary
//!      lives at `target/deploy-test/pushflip.so` (built by tests/build.rs)
//!      and the deploy binary lives at `target/deploy/pushflip.so`. They
//!      cannot clobber each other. See Task 3.A.1 / H1.
//!
//!   2. **Loud build-time warning** (this script). Any `cargo build-sbf
//!      --features skip-zk-verify` invocation prints `cargo:warning=` lines
//!      that show up in red in cargo output and cannot be suppressed.
//!
//!   3. **Loud runtime log in commit_deck** (`program/src/instructions/commit_deck.rs`).
//!      Every successful `commit_deck` call on a `skip-zk-verify` binary
//!      emits a `msg!()` log line that's visible in every transaction's
//!      Solana Explorer logs.
//!
//!   4. **Documentation in EXECUTION_PLAN.md** Pre-Mainnet Checklist
//!      reminding the operator to rebuild with the default feature set
//!      before mainnet deploy.

fn main() {
    // Re-run the warning whenever the feature flag toggles between builds.
    println!("cargo:rerun-if-env-changed=CARGO_FEATURE_SKIP_ZK_VERIFY");

    if std::env::var_os("CARGO_FEATURE_SKIP_ZK_VERIFY").is_some() {
        println!("cargo:warning==================================================================");
        println!("cargo:warning=  pushflip is being built with --features skip-zk-verify.");
        println!("cargo:warning=  This binary IS NOT SAFE to deploy to mainnet or to any devnet");
        println!("cargo:warning=  game session that uses real $FLIP tokens. commit_deck will");
        println!("cargo:warning=  accept ANY proof bytes (including all zeros).");
        println!("cargo:warning=");
        println!("cargo:warning=  This binary is intended ONLY for use by tests/build.rs, which");
        println!("cargo:warning=  outputs to target/deploy-test/pushflip.so (NOT target/deploy/).");
        println!("cargo:warning=");
        println!("cargo:warning=  If you see this warning during a manual `cargo build-sbf` run,");
        println!("cargo:warning=  the binary at target/deploy/pushflip.so will be the unsafe one.");
        println!("cargo:warning=  Rebuild WITHOUT --features skip-zk-verify before deploying.");
        println!("cargo:warning==================================================================");
    }
}
