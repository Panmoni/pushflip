/**
 * Dealer service — HTTP daemon wrapping the `Dealer` class.
 *
 * Pre-Mainnet 5.2 / Phase 4. Code-complete pre-deploy 2026-04-28;
 * concrete deploy gated on the open decisions in
 * `docs/wiki/operations/dealer-runbook.md`.
 *
 * Surface:
 *   - `GET  /health`                                    liveness + dealer state
 *   - `POST /commit/:gameId`                            operator-triggered shuffle + commit_deck
 *   - `GET  /round/:gameId`                             round state (round_number, next_leaf_index)
 *   - `GET  /reveal/:gameId/:roundNumber/:leafIndex`    next card + Merkle proof for hit()
 *
 * Auto-commit poll loop (Decision #2): every POLL_INTERVAL_MS the
 * service reads the GameSession account, and when it sees
 * `!round_active && active_player_count >= MIN_PLAYERS_TO_COMMIT &&
 *  current round_number > committedRoundNumber`, it auto-runs
 * `commitDeckForGame` via the same code path as the manual
 * `POST /commit` endpoint. The manual endpoint stays as a fallback
 * for operator override.
 *
 * Concurrency: single in-memory `Dealer` instance, one round at a time
 * for one game at a time. Multi-game support is a later increment —
 * for the demo with `game_id=2` only, single-instance is sufficient.
 *
 * Crash semantics: if the service dies mid-round, the in-memory deck +
 * Merkle tree are lost. Players who haven't hit yet cannot proceed
 * until `end_round` resolves the round. Documented risk; acceptable
 * for the devnet demo. Mainnet would require either persistence of
 * the shuffled deck (encrypted, since the deck is the secret) or a
 * different protocol.
 *
 * Authority model: the dealer service holds a Solana keypair that's
 * the registered dealer for its game (set via `init_game`'s `dealer`
 * field). The same blast-radius separation as the faucet: the dealer
 * keypair on the VPS can only sign `commit_deck` on its specific
 * game; compromise yields "can re-shuffle this game's deck," not
 * arbitrary token movement.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { serve } from "@hono/node-server";
import {
  decodeGameSession,
  deriveGamePda,
} from "@pushflip/client";
import {
  type Address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  devnet,
  type KeyPairSigner,
  parseBase64RpcAccount,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  sendAndConfirmTransactionFactory,
} from "@solana/kit";
import { Hono } from "hono";
import { cors } from "hono/cors";

import {
  type AutoCommitTickDeps,
  type RoundSnapshot,
  MIN_PLAYERS_TO_COMMIT,
  POLL_INTERVAL_MS,
  startAutoCommitLoop as startAutoCommitLoopGeneric,
} from "./auto-commit.js";
import { commitDeckForGame } from "./commit-tx.js";
import { Dealer, type DealerConfig } from "./dealer.js";

// ============================================================================
// Configuration
// ============================================================================

interface ServiceConfig {
  port: number;
  allowedOrigins: string[];
  rpcEndpoint: string;
  wsEndpoint: string;
  dealerKeypairPath: string;
  zkArtifactsDir: string;
  /** The game_id this dealer instance services. Single-game v1. */
  gameId: bigint;
}

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function loadConfig(): ServiceConfig {
  const portRaw = process.env.PORT?.trim() || "3002";
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`PORT must be a positive integer in [1, 65535], got: ${portRaw}`);
  }
  const gameIdRaw = required("GAME_ID");
  let gameId: bigint;
  try {
    gameId = BigInt(gameIdRaw);
  } catch {
    throw new Error(`GAME_ID must be a u64 decimal, got: ${gameIdRaw}`);
  }
  return {
    port,
    allowedOrigins: (process.env.ALLOWED_ORIGINS?.trim() || "http://localhost:5173")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    rpcEndpoint: required("RPC_ENDPOINT"),
    wsEndpoint: required("WS_ENDPOINT"),
    dealerKeypairPath: required("DEALER_KEYPAIR_PATH"),
    zkArtifactsDir: required("ZK_ARTIFACTS_DIR"),
    gameId,
  };
}

function loadKeypairBytes(path: string): Uint8Array {
  const resolved = resolve(path);
  let raw: string;
  try {
    raw = readFileSync(resolved, "utf-8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(
        `Dealer keypair not found at ${resolved}. Set DEALER_KEYPAIR_PATH to a valid keypair file.`
      );
    }
    throw new Error(
      `Failed to read dealer keypair at ${resolved}: ${err.message ?? String(e)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Dealer keypair at ${resolved} is not valid JSON: ${msg}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Dealer keypair at ${resolved} is not a 64-byte secret-key array (got: ${typeof parsed}).`
    );
  }
  return new Uint8Array(parsed);
}

// ============================================================================
// Dealer state (single instance, single game, single round-at-a-time)
// ============================================================================

interface DealerContext {
  dealer: Dealer;
  authority: KeyPairSigner;
  rpc: Rpc<SolanaRpcApi>;
  rpcSubs: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory>;
  config: ServiceConfig;
  /** Cached PDA for the dealer's single game. Computed once at boot. */
  gameSessionPda: Address;
  /** The on-chain `round_number` this dealer's current deck was committed for. */
  committedRoundNumber: bigint | null;
  /**
   * Mutex flag for the auto-commit poll loop. Set during a commit
   * tx; prevents the next 5s tick from issuing a parallel commit
   * while the prior one is still confirming. Same single-threaded-
   * Node-event-loop reasoning as the faucet's pendingClaims Set.
   */
  commitInFlight: boolean;
}

async function buildDealerContext(config: ServiceConfig): Promise<DealerContext> {
  const dealerConfig: DealerConfig = {
    wasmPath: resolve(config.zkArtifactsDir, "shuffle_verify_js/shuffle_verify.wasm"),
    zkeyPath: resolve(config.zkArtifactsDir, "shuffle_verify_final.zkey"),
    vkeyPath: resolve(config.zkArtifactsDir, "verification_key.json"),
  };
  // Pre-flight check: if any ZK artifact is missing, fail at boot
  // rather than at first commit. Same fail-fast discipline as the
  // faucet's keypair load.
  for (const [name, path] of Object.entries(dealerConfig)) {
    try {
      readFileSync(path);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      throw new Error(
        `Dealer ZK artifact ${name} not found at ${path}: ${err.message ?? String(e)}. Set ZK_ARTIFACTS_DIR to the directory containing shuffle_verify_js/, shuffle_verify_final.zkey, and verification_key.json.`
      );
    }
  }
  const dealer = new Dealer(dealerConfig);

  const rpc = createSolanaRpc(devnet(config.rpcEndpoint));
  const rpcSubs = createSolanaRpcSubscriptions(devnet(config.wsEndpoint));
  const sendAndConfirm = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions: rpcSubs,
  });
  const authority = await createKeyPairSignerFromBytes(
    loadKeypairBytes(config.dealerKeypairPath)
  );
  const [gameSessionPda] = await deriveGamePda(config.gameId);

  return {
    dealer,
    authority,
    rpc,
    rpcSubs,
    sendAndConfirm,
    config,
    gameSessionPda,
    committedRoundNumber: null,
    commitInFlight: false,
  };
}

// ============================================================================
// HTTP API
// ============================================================================

export function createApp(ctx: DealerContext): Hono {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: ctx.config.allowedOrigins,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    })
  );

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      authority: ctx.authority.address,
      game_id: ctx.config.gameId.toString(),
      round_active: ctx.dealer.isRoundActive(),
      committed_round_number:
        ctx.committedRoundNumber === null ? null : ctx.committedRoundNumber.toString(),
      next_leaf_index: ctx.dealer.isRoundActive() ? ctx.dealer.getNextLeafIndex() : null,
    })
  );

  app.get("/round/:gameId", (c) => {
    const gameIdParam = c.req.param("gameId");
    if (gameIdParam !== ctx.config.gameId.toString()) {
      return c.json(
        {
          error: "wrong_game",
          message: `This dealer services game_id=${ctx.config.gameId}, not ${gameIdParam}`,
        },
        404
      );
    }
    if (!ctx.dealer.isRoundActive()) {
      return c.json({ status: "no_round", round_active: false });
    }
    return c.json({
      status: "active",
      round_active: true,
      committed_round_number:
        ctx.committedRoundNumber === null ? null : ctx.committedRoundNumber.toString(),
      next_leaf_index: ctx.dealer.getNextLeafIndex(),
    });
  });

  // POST /commit/:gameId is intentionally NOT exposed.
  //
  // An earlier draft kept it as an "operator override" alongside the
  // auto-commit poll loop, but the route would have been reachable
  // unauthenticated through the public `/api/dealer/*` nginx prefix,
  // and the route lacked the `activePlayerCount >= MIN_PLAYERS_TO_COMMIT`
  // guard the auto-loop has. An attacker could have hit it the moment
  // a single player joined, forcing a 1-of-N commit and burning ~30s
  // of dealer CPU + SOL per commit. The auto-commit path is sufficient
  // for the demo; if an operator override surface is needed later, add
  // it back behind a shared-secret header (`X-Dealer-Operator: ...`)
  // matched against an env-loaded token AND with the same player-count
  // guard.

  app.get("/reveal/:gameId/:roundNumber/:leafIndex", (c) => {
    const gameIdParam = c.req.param("gameId");
    const roundParam = c.req.param("roundNumber");
    const leafParam = c.req.param("leafIndex");

    if (gameIdParam !== ctx.config.gameId.toString()) {
      return c.json({ error: "wrong_game" }, 404);
    }
    if (!ctx.dealer.isRoundActive()) {
      return c.json({ error: "no_active_round" }, 409);
    }
    if (
      ctx.committedRoundNumber === null ||
      roundParam !== ctx.committedRoundNumber.toString()
    ) {
      return c.json(
        {
          error: "round_mismatch",
          message: `This dealer's current round is ${ctx.committedRoundNumber}, not ${roundParam}`,
        },
        409
      );
    }
    const leafIndex = Number.parseInt(leafParam, 10);
    if (!Number.isInteger(leafIndex) || leafIndex < 0) {
      return c.json({ error: "invalid_leaf_index" }, 400);
    }
    try {
      const reveal = ctx.dealer.revealCard(leafIndex);
      return c.json({
        status: "ok",
        leaf_index: reveal.leafIndex,
        card: {
          card_type: reveal.card.cardType,
          value: reveal.card.value,
          suit: reveal.card.suit,
        },
        // 7 sibling hashes, 32 bytes each, hex-encoded for transport.
        merkle_proof: reveal.proof.map((b) => Buffer.from(b).toString("hex")),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // revealCard() throws on out-of-order requests; surface that
      // distinctly so the frontend can display "wait your turn".
      return c.json({ error: "reveal_failed", message: msg }, 409);
    }
  });

  return app;
}

// ============================================================================
// GameSession polling + auto-commit loop (Decision #2)
// ============================================================================

/**
 * Read the GameSession PDA + return the round-relevant fields. Returns
 * `null` if the account doesn't exist yet (game not initialized) so the
 * caller can no-op on the next poll.
 */
async function fetchGameSession(ctx: DealerContext): Promise<RoundSnapshot | null> {
  const account = await ctx.rpc
    .getAccountInfo(ctx.gameSessionPda, { encoding: "base64" })
    .send();
  const parsed = parseBase64RpcAccount(ctx.gameSessionPda, account.value);
  if (!parsed.exists) {
    return null;
  }
  const gs = decodeGameSession(parsed.data);
  return {
    roundActive: gs.roundActive,
    deckCommitted: gs.deckCommitted,
    roundNumber: gs.roundNumber,
    activePlayerCount: gs.playerCount,
  };
}

/**
 * Decision #2 — auto-commit when enough players have joined and no
 * round is currently active. Wires the pure tick (in
 * `auto-commit.ts`) to the production I/O surface: real RPC fetch,
 * real `commitDeckForGame`, real `Dealer` instance, `[dealer]`-
 * prefixed `console` logging.
 *
 * The state-machine logic + the H1/H2 fixes from heavy-duty review
 * #19 live in `auto-commit.ts` so they can be unit-tested without
 * standing up the RPC / keypair / snarkjs stack. See
 * `auto-commit.test.ts` for the regression-coverage suite.
 */
function startServiceAutoCommitLoop(ctx: DealerContext): NodeJS.Timeout {
  const deps: AutoCommitTickDeps = {
    fetchSnapshot: () => fetchGameSession(ctx),
    commitDeck: async () => {
      const result = await commitDeckForGame({
        dealer: ctx.dealer,
        dealerSigner: ctx.authority,
        rpc: ctx.rpc,
        sendAndConfirm: ctx.sendAndConfirm,
        gameId: ctx.config.gameId,
      });
      return { signature: result.signature };
    },
    isRoundActive: () => ctx.dealer.isRoundActive(),
    resetDealer: () => ctx.dealer.reset(),
    minPlayersToCommit: MIN_PLAYERS_TO_COMMIT,
    log: (line) => console.log(`[dealer] ${line}`),
    warn: (line) => console.warn(`[dealer] ${line}`),
    errorLog: (line) => console.error(`[dealer] ${line}`),
  };
  return startAutoCommitLoopGeneric(ctx, deps);
}

// ============================================================================
// Entry point
// ============================================================================

export async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = await buildDealerContext(config);

  // Boot-time SOL balance check — same fail-fast discipline as the faucet.
  // The dealer pays fees for commit_deck (~5K lamports per round) so a
  // chronically-empty authority is the most common cause of silent
  // mid-deploy breakage.
  let balance: bigint;
  try {
    const res = await ctx.rpc
      .getBalance(ctx.authority.address, { commitment: "confirmed" })
      .send();
    balance = res.value;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[dealer] FATAL: RPC health check failed: ${msg}`);
    process.exit(1);
  }
  const MIN_LAMPORTS = 1_000_000n;
  if (balance < MIN_LAMPORTS) {
    console.error(
      `[dealer] FATAL: authority ${ctx.authority.address} has only ${balance} lamports (< 0.001 SOL). Fund the dealer before starting the service.`
    );
    process.exit(1);
  }

  const app = createApp(ctx);
  // Bind to loopback explicitly. `@hono/node-server` defaults to
  // `0.0.0.0`, and the quadlet uses `Network=host`, so without an
  // explicit hostname the dealer would be reachable on every tucker
  // interface (including the public IP) — bypassing nginx's rate
  // limit zone (`dealer_req`) and the cloudflare-real-ip snippet.
  // 127.0.0.1 is the only interface nginx (also Network=host) needs
  // to reach us on.
  serve({
    fetch: app.fetch,
    port: config.port,
    hostname: "127.0.0.1",
  });

  // Decision #2 — start auto-commit poll loop.
  const pollHandle = startServiceAutoCommitLoop(ctx);

  // SIGTERM/SIGINT: stop the poll loop cleanly so a deploy-time
  // redeploy doesn't leave a half-committed round in flight. The HTTP
  // server's own listen socket is closed by Node when the process
  // exits; we just need to clear the poll interval.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      console.log(`[dealer] received ${signal}, stopping poll loop`);
      clearInterval(pollHandle);
      // Give in-flight HTTP responses up to 5s to drain before exit.
      setTimeout(() => process.exit(0), 5_000).unref();
    });
  }

  console.log(
    `[dealer] listening on http://localhost:${config.port}  authority=${ctx.authority.address}  game_id=${config.gameId}  pda=${ctx.gameSessionPda}  balance=${balance} lamports`
  );
  console.log(`[dealer] allowed origins: ${config.allowedOrigins.join(", ")}`);
  console.log(`[dealer] zk artifacts: ${config.zkArtifactsDir}`);
  console.log(
    `[dealer] auto-commit poll: every ${POLL_INTERVAL_MS}ms when player_count >= ${MIN_PLAYERS_TO_COMMIT}`
  );
}

// Suppress no-floating-promises by guarding the entry point: this
// module is dual-purpose (importable as a library + runnable as
// `tsx src/service.ts`). Only run main() when invoked directly.
const isDirectInvocation = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  main().catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[dealer] fatal: ${msg}`);
    process.exit(1);
  });
}
