/**
 * Env-driven configuration for the faucet service. Fails fast at import
 * time if anything required is missing or malformed — a misconfigured
 * faucet is worse than a missing one because it can silently mint to the
 * wrong mint or get stuck in a retry loop.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv();

function required(name: string): string {
  const val = process.env[name]?.trim();
  if (!val) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return val;
}

function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function parsePositiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Env var ${name} must be a positive integer, got: ${raw}`);
  }
  return n;
}

export const CONFIG = {
  port: parsePositiveInt("PORT", optional("PORT", "3001")),
  allowedOrigins: optional("ALLOWED_ORIGINS", "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  keypairPath: required("FAUCET_KEYPAIR_PATH"),
  rpcEndpoint: required("RPC_ENDPOINT"),
  wsEndpoint: required("WS_ENDPOINT"),
  faucetAmountWhole: BigInt(
    parsePositiveInt(
      "FAUCET_AMOUNT_WHOLE_FLIP",
      optional("FAUCET_AMOUNT_WHOLE_FLIP", "1000")
    )
  ),
  cooldownMs:
    parsePositiveInt("COOLDOWN_MINUTES", optional("COOLDOWN_MINUTES", "1440")) *
    60 *
    1000,
  logLevel: optional("LOG_LEVEL", "info"),
} as const;

/**
 * Read + parse the faucet keypair eagerly so a misconfigured path fails
 * at boot, not on the first request. Mirrors the friendly-error
 * handling in `scripts/lib/script-helpers.ts::loadCliKeypair`.
 */
export function loadFaucetKeypairBytes(): Uint8Array {
  const path = resolve(CONFIG.keypairPath);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(
        `Faucet keypair not found at ${path}. Set FAUCET_KEYPAIR_PATH to a valid keypair file (the mint authority for TEST_FLIP_MINT).`
      );
    }
    if (err.code === "EACCES") {
      throw new Error(
        `Permission denied reading ${path}. File should be mode 0600 and owned by the service user.`
      );
    }
    throw new Error(
      `Failed to read faucet keypair at ${path}: ${err.message ?? String(e)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Faucet keypair at ${path} is not valid JSON: ${msg}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Faucet keypair at ${path} is not a 64-byte secret-key array (got: ${typeof parsed}).`
    );
  }
  return new Uint8Array(parsed);
}
