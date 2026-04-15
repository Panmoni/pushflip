/**
 * Hono HTTP server exposing two endpoints:
 *   POST /faucet       — mint test $FLIP to a recipient (rate-limited)
 *   GET  /health       — liveness + balance of the faucet authority
 *
 * CORS is locked to `CONFIG.allowedOrigins`; a mis-origin'd request is
 * rejected before the handler runs. Rate-limit state is in-memory
 * (see rate-limit.ts) and is per-wallet, not per-IP — sybil resistance
 * is not a goal for a devnet test-token faucet.
 */

import type { Address } from "@solana/kit";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { CONFIG } from "./config";
import {
  FAUCET_MINT,
  type FaucetContext,
  mintToRecipient,
  parseRecipient,
} from "./mint";
import { releaseClaim, tryAcquireClaim } from "./rate-limit";

interface FaucetRequestBody {
  recipient?: unknown;
}

export function createApp(ctx: FaucetContext): Hono {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: CONFIG.allowedOrigins,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    })
  );

  app.get("/health", async (c) => {
    let balanceLamports: bigint | null = null;
    try {
      const res = await ctx.rpc
        .getBalance(ctx.authority.address, { commitment: "confirmed" })
        .send();
      balanceLamports = res.value;
    } catch {
      // Surface the failure via the response rather than throwing — we
      // want /health to return 200 even when RPC is briefly unhappy.
    }
    return c.json({
      status: "ok",
      authority: ctx.authority.address,
      mint: FAUCET_MINT,
      balance_lamports:
        balanceLamports === null ? null : balanceLamports.toString(),
      faucet_amount_whole_flip: CONFIG.faucetAmountWhole.toString(),
      cooldown_minutes: CONFIG.cooldownMs / 1000 / 60,
    });
  });

  app.post("/faucet", async (c) => {
    let body: FaucetRequestBody;
    try {
      body = (await c.req.json()) as FaucetRequestBody;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    let recipient: Address;
    try {
      recipient = parseRecipient(body.recipient);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 400);
    }

    const decision = tryAcquireClaim(recipient);
    if (decision.status === "in_flight") {
      // Another request for this wallet is currently minting. Reject
      // to close the concurrent-request bypass window (16th heavy-duty
      // review Critical fix). Report as 429 so the client can surface
      // the standard rate-limit UX.
      return c.json(
        {
          error: "rate_limited",
          message:
            "Another request for this wallet is already in flight. Please wait for it to complete.",
        },
        429
      );
    }
    if (decision.status === "cooldown") {
      return c.json(
        {
          error: "rate_limited",
          message: `This wallet can request the faucet once per ${CONFIG.cooldownMs / 1000 / 60} minutes. Try again in ${decision.retryAfterSeconds} seconds.`,
          retry_after_seconds: decision.retryAfterSeconds,
          next_available_at_ms: decision.nextAvailableAt,
        },
        429
      );
    }

    // From here on we MUST call releaseClaim exactly once, true on
    // success (records the claim and starts the cooldown) or false on
    // failure (clears pending, allows immediate retry).
    try {
      const result = await mintToRecipient(ctx, recipient);
      releaseClaim(recipient, true);
      return c.json({
        status: "ok",
        signature: result.signature,
        recipient_ata: result.recipientAta,
        amount_base_units: result.amountBaseUnits.toString(),
        amount_whole_flip: CONFIG.faucetAmountWhole.toString(),
        explorer_url: `https://explorer.solana.com/tx/${result.signature}?cluster=devnet`,
      });
    } catch (e) {
      releaseClaim(recipient, false);
      // Log the full error internally but return a generic message to
      // the client. Raw RPC errors can contain the RPC URL, the
      // authority pubkey, or other internal details that don't belong
      // on a public endpoint (16th heavy-duty review M3).
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[faucet] mint failed for ${recipient}:`, msg);
      return c.json(
        {
          error: "mint_failed",
          message: "Mint failed. Please retry in a moment.",
        },
        500
      );
    }
  });

  return app;
}
