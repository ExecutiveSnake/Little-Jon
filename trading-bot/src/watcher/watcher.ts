import { config } from "../config.js";
import { logger } from "../logger.js";
import { insertPricePoint } from "../candles/store.js";
import { getKnownToken } from "../tokens/registry.js";
import { listPositions, markCancelled, type Position } from "../positions/store.js";
import { evaluatePosition } from "../positions/triggers.js";
import { readTrustedPrice } from "./prices.js";
import { executeEntry, executeExit } from "./actions.js";
import { notify } from "../notify/notifier.js";

/**
 * The Little Jon watcher: one shared backend loop that serves every open position
 * across every user. Each tick it
 *
 *   1. reads one trusted price per distinct active token (cheap on-chain reads —
 *      no Claude/credit cost),
 *   2. appends the reading to the candle store (the "keep building on our own
 *      indexing" half of the history plan),
 *   3. evaluates entry triggers, stop-losses, and take-profits, and
 *   4. executes whatever those evaluations demand.
 *
 * SL/TP protection is only as live as this process — run it as a service
 * (systemd/pm2/Docker), not a terminal you might close.
 */

let running = false;

export async function tick(nowSec = Math.floor(Date.now() / 1000)): Promise<void> {
  const active = listPositions(["awaiting_entry", "open"]);
  if (active.length === 0) return;

  const byToken = new Map<string, Position[]>();
  for (const p of active) {
    const list = byToken.get(p.token) ?? [];
    list.push(p);
    byToken.set(p.token, list);
  }

  for (const [tokenAddress, positions] of byToken) {
    const token = getKnownToken(tokenAddress, positions[0]!.chain);
    if (!token) {
      logger.error({ tokenAddress }, "active position references unknown token — skipping");
      continue;
    }

    let price: number;
    try {
      price = await readTrustedPrice(token);
    } catch (err) {
      // Oracle paused / stale / sequencer down: prices can't be trusted, so no
      // trigger may fire — better to do nothing than act on a bad price.
      logger.warn({ err, token: token.symbol }, "no trusted price this tick; skipping token");
      continue;
    }

    insertPricePoint(token.key, nowSec, price, 0, "watcher");

    for (const position of positions) {
      const action = evaluatePosition(position, price, nowSec);
      if (!action) continue;

      logger.info(
        { positionId: position.id, symbol: token.symbol, action, price },
        "trigger fired",
      );

      if (action.type === "cancel") {
        markCancelled(position.id, action.reason);
        await notify(
          `entry expired ${token.symbol} (#${position.id})`,
          `trigger never hit (or setup invalidated) — proposal cancelled`,
        );
      } else if (action.type === "enter") {
        await executeEntry(position, token, price);
      } else {
        await executeExit(position, token, price, action.reason);
      }
    }
  }
}

export async function startWatcher(): Promise<void> {
  if (running) return;
  running = true;
  logger.info(
    { intervalMs: config.WATCHER_POLL_INTERVAL_MS },
    "Little Jon watcher started",
  );

  // Serial loop (not setInterval): a slow tick must never overlap the next one.
  while (running) {
    const started = Date.now();
    try {
      await tick();
    } catch (err) {
      logger.error({ err }, "watcher tick crashed (loop continues)");
    }
    const elapsed = Date.now() - started;
    const waitMs = Math.max(0, config.WATCHER_POLL_INTERVAL_MS - elapsed);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

export function stopWatcher(): void {
  running = false;
}
