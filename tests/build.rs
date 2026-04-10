//! Build script for the pushflip integration tests.
//!
//! ## Why this exists
//!
//! Integration tests embed the on-chain program's `.so` bytes via
//! `include_bytes!` and run it under LiteSVM. The production deploy binary
//! (`target/deploy/pushflip.so`) is built WITHOUT the `skip-zk-verify`
//! feature — it must enforce real Groth16 verification on devnet/mainnet.
//! But test fixtures use all-zero proof bytes (a real proof costs ~20s to
//! generate), so tests need a binary built WITH `skip-zk-verify`.
//!
//! Before this build script existed, both binaries shared
//! `target/deploy/pushflip.so`. Any `cargo build-sbf` invocation clobbered
//! whichever build mode the previous invocation used, and tests would go
//! red the moment someone built for deploy. Lesson #9 in EXECUTION_PLAN.md
//! (the `cargo build-sbf` workspace gotcha) is the surface symptom of this
//! underlying coupling.
//!
//! ## What it does
//!
//! 1. Builds the program with `--features skip-zk-verify` into a
//!    DEDICATED path — `target/deploy-test/pushflip.so` — so the prod
//!    deploy artifact (`target/deploy/pushflip.so`) is never touched.
//! 2. Exports the resulting path via the `PUSHFLIP_TEST_SBF_PATH` env var
//!    so tests can `include_bytes!(env!("PUSHFLIP_TEST_SBF_PATH"))` without
//!    hard-coding a path.
//! 3. Uses `cargo:rerun-if-changed` on program sources so the test binary
//!    rebuilds automatically whenever on-chain code changes, and is cached
//!    across runs otherwise.
//!
//! ## Nested cargo / lock avoidance
//!
//! This script runs inside `cargo test`, which holds a lock on the main
//! workspace target directory. To avoid a deadlock when the nested
//! `cargo build-sbf` tries to acquire the same lock, we set
//! `CARGO_TARGET_DIR` to an isolated directory for the child process.

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    // Rerun when program source or its Cargo.toml changes. The script is
    // otherwise cached: repeated `cargo test` invocations reuse the
    // previously built test binary.
    println!("cargo:rerun-if-changed=../program/src");
    println!("cargo:rerun-if-changed=../program/Cargo.toml");
    println!("cargo:rerun-if-changed=build.rs");

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let workspace_root = manifest_dir
        .parent()
        .expect("tests/ must have a parent")
        .to_path_buf();

    let sbf_out_dir = workspace_root.join("target").join("deploy-test");
    let nested_target_dir = sbf_out_dir.join("cargo-target");
    let test_binary = sbf_out_dir.join("pushflip.so");

    std::fs::create_dir_all(&sbf_out_dir)
        .unwrap_or_else(|e| panic!("failed to create {}: {e}", sbf_out_dir.display()));
    std::fs::create_dir_all(&nested_target_dir)
        .unwrap_or_else(|e| panic!("failed to create {}: {e}", nested_target_dir.display()));

    run_build_sbf(&workspace_root, &sbf_out_dir, &nested_target_dir);

    if !test_binary.exists() {
        panic!(
            "cargo build-sbf reported success but {} is missing. \
             Check that program/src/lib.rs compiles for the SBF target.",
            test_binary.display()
        );
    }

    // Expose the resolved absolute path to the test code. `include_bytes!`
    // accepts string literals, and `env!()` expands to one at compile time,
    // so `include_bytes!(env!("PUSHFLIP_TEST_SBF_PATH"))` is valid.
    println!(
        "cargo:rustc-env=PUSHFLIP_TEST_SBF_PATH={}",
        test_binary.display()
    );
}

fn run_build_sbf(workspace_root: &Path, sbf_out_dir: &Path, nested_target_dir: &Path) {
    let mut cmd = Command::new("cargo");
    cmd.args([
        "build-sbf",
        "--manifest-path",
        "program/Cargo.toml",
        "--features",
        "skip-zk-verify",
        "--sbf-out-dir",
    ])
    .arg(sbf_out_dir)
    .current_dir(workspace_root)
    // Isolate the nested cargo's target directory so it cannot deadlock on
    // the parent `cargo test` invocation's workspace target lock.
    .env("CARGO_TARGET_DIR", nested_target_dir);

    // Strip every variable that the *outer* cargo invocation might have set
    // to point at a wrapper rustc. cargo-build-sbf needs to use the SBF
    // toolchain's own rustc directly. The most common offender is
    // `RUSTC_WRAPPER=clippy-driver` set by `cargo clippy` — clippy-driver
    // wraps the host rustc and has no idea how to spec the
    // `sbpf-solana-solana` target, so the nested build fails with
    // "could not find specification for target". The same hazard exists
    // for `sccache`, `RUSTC_WORKSPACE_WRAPPER`, and any pinned `RUSTC`.
    for var in [
        "RUSTC",
        "RUSTC_WRAPPER",
        "RUSTC_WORKSPACE_WRAPPER",
        "RUSTFLAGS",
        "CARGO_ENCODED_RUSTFLAGS",
    ] {
        cmd.env_remove(var);
    }

    let status = cmd.status();
    match status {
        Ok(s) if s.success() => {}
        Ok(s) => panic!(
            "cargo build-sbf exited with status {s}. \
             Manual rebuild:\n  \
             cargo build-sbf --manifest-path program/Cargo.toml \\\n    \
               --features skip-zk-verify \\\n    \
               --sbf-out-dir target/deploy-test"
        ),
        Err(e) => panic!(
            "failed to spawn `cargo build-sbf`: {e}. \
             Ensure the Solana platform-tools are installed and `cargo-build-sbf` is on PATH. \
             Manual rebuild:\n  \
             cargo build-sbf --manifest-path program/Cargo.toml \\\n    \
               --features skip-zk-verify \\\n    \
               --sbf-out-dir target/deploy-test"
        ),
    }
}
