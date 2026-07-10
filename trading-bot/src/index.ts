import { logger } from "./logger.js";
import { executeGuardedTrade, type TradeRequest } from "./trade/executor.js";

/**
 * This is a scaffold entrypoint, not a runnable strategy. It shows the shape of a
 * single guarded trade cycle: build a TradeRequest from your own strategy/DEX
 * integration, then hand it to `executeGuardedTrade`, which enforces every guardrail
 * (kill switch, daily loss breaker, position size, slippage, mandatory analysis,
 * session-key scoping) before anything is signed or submitted.
 *
 * Wire up a real loop (polling, event-driven, cron) and real DEX calldata encoding
 * before running this against funds.
 */
async function runOnce(): Promise<void> {
  const request: TradeRequest = {
    symbol: "AAPL",
    kind: "stock-token",
    chainlinkFeed: "0x0000000000000000000000000000000000dEAD",
    targetContract: "0x0000000000000000000000000000000000dEAD",
    selector: "0x38ed1739",
    callData: "0x",
    value: 0n,
    notionalUsd: 0,
    quotedPrice: 0,
  };

  logger.warn(
    "index.ts is a scaffold — replace this stub TradeRequest with real strategy/DEX logic before running.",
  );

  await executeGuardedTrade(request, (analysis) => {
    logger.info({ analysis }, "analysis received");
    return analysis.score > 0.6;
  });
}

runOnce().catch((err) => {
  logger.error({ err }, "guarded trade cycle failed");
  process.exit(1);
});
