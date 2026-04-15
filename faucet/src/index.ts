/**
 * Faucet service entry point. Boots the Hono app on CONFIG.port and
 * logs a one-line startup banner with the faucet authority + balance
 * so operators can tell at a glance whether the service is healthy.
 */

import { serve } from "@hono/node-server";

import { CONFIG } from "./config";
import { createFaucetContext, FAUCET_MINT } from "./mint";
import { createApp } from "./server";

async function main(): Promise<void> {
  const ctx = await createFaucetContext();

  // Boot-time balance check so misconfigured deploys scream early.
  let balanceLamports: bigint;
  try {
    const res = await ctx.rpc
      .getBalance(ctx.authority.address, { commitment: "confirmed" })
      .send();
    balanceLamports = res.value;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[faucet] RPC health check failed: ${msg}`);
    process.exit(1);
  }

  // Fail-fast if the faucet can't actually pay for a mint. A silently
  // 500-ing service is worse than a service that refuses to start
  // because it tells the operator exactly what's wrong upfront.
  // Threshold ≈ 100× the cost of one mint tx (~5000 lamports), so at
  // 0.5M lamports the faucet has room for ~100 requests before it's
  // empty — enough to catch the issue before prod users see 500s.
  // (16th heavy-duty review M4.)
  const MIN_SOL_LAMPORTS = 500_000n;
  if (balanceLamports < MIN_SOL_LAMPORTS) {
    console.error(
      `[faucet] FATAL: authority ${ctx.authority.address} has only ${balanceLamports} lamports (< 0.0005 SOL). Fund the faucet (solana airdrop, transfer, etc.) before starting the service.`
    );
    process.exit(1);
  }

  const app = createApp(ctx);

  serve({
    fetch: app.fetch,
    port: CONFIG.port,
  });

  console.log(
    `[faucet] listening on http://localhost:${CONFIG.port}  authority=${ctx.authority.address}  mint=${FAUCET_MINT}  balance=${balanceLamports} lamports  cooldown=${CONFIG.cooldownMs / 1000 / 60}m  amount=${CONFIG.faucetAmountWhole} $FLIP`
  );
  console.log(`[faucet] allowed origins: ${CONFIG.allowedOrigins.join(", ")}`);
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[faucet] fatal: ${msg}`);
  process.exit(1);
});
