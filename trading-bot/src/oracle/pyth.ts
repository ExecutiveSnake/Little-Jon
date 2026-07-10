import { config } from "../config.js";
import { logger } from "../logger.js";
import { insertPricePoint } from "../candles/store.js";
import { StalePriceError } from "./chainlink.js";

/**
 * Pyth price source for major assets: latest prices from Hermes (free HTTP,
 * no key, no credit cost — the watcher can poll this every tick), history
 * from the Pyth Benchmarks TradingView shim.
 */

interface HermesParsed {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
}

export async function readPythPrice(
  feedId: string,
  maxStalenessSec = config.PYTH_MAX_STALENESS_SEC,
): Promise<number> {
  const url = `${config.PYTH_HERMES_URL}/v2/updates/price/latest?ids[]=${feedId}&parsed=true`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Pyth Hermes HTTP ${res.status}`);
  const body = (await res.json()) as { parsed?: HermesParsed[] };
  const feed = body.parsed?.[0];
  if (!feed) throw new Error(`Pyth returned no data for feed ${feedId}`);

  const ageSec = Date.now() / 1000 - feed.price.publish_time;
  if (ageSec > maxStalenessSec) {
    throw new StalePriceError(
      `Pyth feed ${feedId} is stale: published ${ageSec.toFixed(0)}s ago (max ${maxStalenessSec}s)`,
    );
  }
  const price = Number(feed.price.price) * 10 ** feed.price.expo;
  if (!(price > 0)) throw new StalePriceError(`Pyth feed ${feedId} returned non-positive price`);
  return price;
}

interface TvHistory {
  s: string;
  t?: number[];
  c?: number[];
  v?: number[];
}

async function fetchBenchmarkBars(
  symbol: string,
  resolution: string,
  fromSec: number,
  toSec: number,
): Promise<TvHistory> {
  const url =
    `${config.PYTH_BENCHMARKS_URL}/v1/shims/tradingview/history` +
    `?symbol=${encodeURIComponent(`Crypto.${symbol}/USD`)}` +
    `&resolution=${resolution}&from=${fromSec}&to=${toSec}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Pyth Benchmarks HTTP ${res.status}`);
  return (await res.json()) as TvHistory;
}

/**
 * One-time history seed for a major asset: hourly bars for the recent window
 * (feeds h1/h4 candles) plus daily bars for the long window (feeds d1).
 * Stored as close-price points; volume where the shim provides it.
 */
export async function backfillPyth(tokenKey: string, symbol: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  let inserted = 0;

  const windows: { resolution: string; fromSec: number }[] = [
    { resolution: "60", fromSec: now - 90 * 86_400 },
    { resolution: "1D", fromSec: now - 400 * 86_400 },
  ];

  for (const { resolution, fromSec } of windows) {
    const bars = await fetchBenchmarkBars(symbol, resolution, fromSec, now);
    if (bars.s !== "ok" || !bars.t || !bars.c) {
      logger.warn({ symbol, resolution, status: bars.s }, "pyth benchmarks returned no bars");
      continue;
    }
    for (let i = 0; i < bars.t.length; i++) {
      const t = bars.t[i];
      const close = bars.c[i];
      if (t === undefined || close === undefined) continue;
      insertPricePoint(tokenKey, t, close, bars.v?.[i] ?? 0, "pyth-backfill");
      inserted++;
    }
  }

  logger.info({ symbol, inserted }, "pyth history backfill complete");
  return inserted;
}
