#!/usr/bin/env node
/**
 * Convert snarkjs verification_key.json to Rust byte arrays compatible with
 * pinocchio-groth16's Groth16Verifyingkey struct.
 *
 * Usage: node export_vk_rust.mjs build/verification_key.json > ../program/src/zk/verifying_key.rs
 *
 * The Solana alt_bn128 syscalls expect big-endian encoding:
 *   G1: x (32B BE) || y (32B BE) = 64 bytes
 *   G2: x_imag (32B BE) || x_real (32B BE) || y_imag (32B BE) || y_real (32B BE) = 128 bytes
 *
 * snarkjs outputs decimal strings for each coordinate component.
 */

import { readFileSync } from "fs";

const vkPath = process.argv[2] || "build/verification_key.json";
const vk = JSON.parse(readFileSync(vkPath, "utf-8"));

function decimalTo32BytesBE(decimal) {
  const hex = BigInt(decimal).toString(16).padStart(64, "0");
  const bytes = [];
  for (let i = 0; i < 64; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return bytes;
}

function formatG1(point) {
  // snarkjs: [x, y, "1"]
  return [...decimalTo32BytesBE(point[0]), ...decimalTo32BytesBE(point[1])];
}

function formatG2(point) {
  // snarkjs vk_*_2 layout: [[x.c0, x.c1], [y.c0, y.c1], ["1","0"]]
  // Solana alt_bn128 syscall expects [c1, c0, c1, c0] order (per EIP-197).
  // This must match how dealer/src/prover.ts serializeG2() writes proof_b.
  return [
    ...decimalTo32BytesBE(point[0][1]), // x.c1 (imaginary)
    ...decimalTo32BytesBE(point[0][0]), // x.c0 (real)
    ...decimalTo32BytesBE(point[1][1]), // y.c1 (imaginary)
    ...decimalTo32BytesBE(point[1][0]), // y.c0 (real)
  ];
}

function formatByteArray(bytes, indent = "        ") {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16);
    lines.push(indent + chunk.join(", ") + ",");
  }
  return lines.join("\n");
}

const alpha_g1 = formatG1(vk.vk_alpha_1);
const beta_g2 = formatG2(vk.vk_beta_2);
const gamma_g2 = formatG2(vk.vk_gamma_2);
const delta_g2 = formatG2(vk.vk_delta_2);

// IC points: vk.IC is an array of G1 points
const ic_points = vk.IC.map(formatG1);
const nrPubInputs = vk.IC.length - 1; // IC has n+1 entries for n public inputs

// Hard-coded sanity check: the on-chain `commit_deck.rs` instruction
// passes EXACTLY 2 public inputs (merkle_root, canonical_hash). If the
// circuit is ever regenerated with a different number of public signals,
// this script would silently emit Rust code with a mismatched
// `NR_PUBLIC_INPUTS`, and `commit_deck` would fail at runtime with a
// cryptic Groth16 error. Catch the divergence here instead.
//
// (Heavy-duty review pass 4 finding M1.)
const EXPECTED_NR_PUBLIC_INPUTS = 2;
if (nrPubInputs !== EXPECTED_NR_PUBLIC_INPUTS) {
  console.error(
    `ERROR: circuit has ${nrPubInputs} public inputs, expected ${EXPECTED_NR_PUBLIC_INPUTS}.`,
  );
  console.error(
    `If you intentionally changed the circuit's public input count, you must also update:`,
  );
  console.error(
    `  - program/src/instructions/commit_deck.rs (the public_inputs array)`,
  );
  console.error(`  - dealer/src/prover.ts (the publicInputs returned by generateProof)`);
  console.error(
    `  - this constant (EXPECTED_NR_PUBLIC_INPUTS) once all of the above match`,
  );
  process.exit(1);
}

console.log(`\
/// Groth16 verifying key for the shuffle verification circuit.
///
/// Generated from trusted setup. Do not edit manually.
/// Re-generate with: node zk-circuits/scripts/export_vk_rust.mjs
///
/// Public inputs: ${nrPubInputs} (merkle_root, canonical_hash)
use pinocchio_groth16::groth16::Groth16Verifyingkey;

pub const NR_PUBLIC_INPUTS: usize = ${nrPubInputs};

pub const VK_ALPHA_G1: [u8; 64] = [
${formatByteArray(alpha_g1)}
];

pub const VK_BETA_G2: [u8; 128] = [
${formatByteArray(beta_g2)}
];

pub const VK_GAMMA_G2: [u8; 128] = [
${formatByteArray(gamma_g2)}
];

pub const VK_DELTA_G2: [u8; 128] = [
${formatByteArray(delta_g2)}
];

pub const VK_IC: [[u8; 64]; ${ic_points.length}] = [
${ic_points.map((p) => `    [\n${formatByteArray(p)}\n    ]`).join(",\n")}
];

pub fn verifying_key() -> Groth16Verifyingkey<'static> {
    Groth16Verifyingkey {
        nr_pubinputs: NR_PUBLIC_INPUTS,
        vk_alpha_g1: VK_ALPHA_G1,
        vk_beta_g2: VK_BETA_G2,
        vk_gamma_g2: VK_GAMMA_G2,
        vk_delta_g2: VK_DELTA_G2,
        vk_ic: &VK_IC,
    }
}`);
