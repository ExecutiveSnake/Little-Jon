import { db } from "../db.js";

export interface Candle {
  t: number; // bucket-open unix seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface PricePoint {
  t: number;
  price: number;
  volume: number;
}

export const TIMEFRAMES = { h1: 3_600, h4: 14_400, d1: 86_400 } as const;
export type TimeframeName = keyof typeof TIMEFRAMES;

/** Lookback per timeframe when assembling the analysis payload. */
const LOOKBACK: Record<TimeframeName, { seconds: number; maxCandles: number }> = {
  h1: { seconds: 5 * 86_400, maxCandles: 120 }, // ~5 days of hourly
  h4: { seconds: 30 * 86_400, maxCandles: 180 }, // ~30 days of 4h
  d1: { seconds: 180 * 86_400, maxCandles: 180 }, // ~6 months of daily
};

const insertStmt = db.prepare(
  `INSERT OR IGNORE INTO price_points (token, t, price, volume, source) VALUES (?, ?, ?, ?, ?)`,
);

/** Records one price observation. Deduped on (token, t, source), so re-running a
 *  backfill or overlapping watcher polls can never double-count. */
export function insertPricePoint(
  token: string,
  t: number,
  price: number,
  volume: number,
  source: string,
): void {
  if (!(price > 0) || !Number.isFinite(price)) return; // never store junk
  insertStmt.run(token.toLowerCase(), Math.floor(t), price, volume, source);
}

export const insertManyPricePoints = db.transaction(
  (token: string, points: PricePoint[], source: string) => {
    for (const p of points) insertPricePoint(token, p.t, p.price, p.volume, source);
  },
);

export function getPricePoints(token: string, fromT: number, toT: number): PricePoint[] {
  const rows = db
    .prepare(
      `SELECT t, price, volume FROM price_points
       WHERE token = ? AND t >= ? AND t <= ? ORDER BY t ASC, id ASC`,
    )
    .all(token.toLowerCase(), Math.floor(fromT), Math.floor(toT)) as {
    t: number;
    price: number;
    volume: number;
  }[];
  return rows.map((r) => ({ t: r.t, price: r.price, volume: r.volume }));
}

/** Earliest stored observation for a token, or null if none. */
export function earliestPointT(token: string): number | null {
  const row = db
    .prepare(`SELECT MIN(t) AS t FROM price_points WHERE token = ?`)
    .get(token.toLowerCase()) as { t: number | null };
  return row.t;
}

/**
 * Pure OHLCV aggregation of raw points into fixed buckets. Points must be sorted
 * ascending by time (getPricePoints guarantees this). Buckets with no observations
 * are simply absent — the analysis layer treats gaps as gaps rather than inventing
 * flat candles.
 */
export function aggregateCandles(points: PricePoint[], timeframeSec: number): Candle[] {
  const candles: Candle[] = [];
  let current: Candle | null = null;

  for (const p of points) {
    const bucket = Math.floor(p.t / timeframeSec) * timeframeSec;
    if (!current || current.t !== bucket) {
      if (current) candles.push(current);
      current = { t: bucket, o: p.price, h: p.price, l: p.price, c: p.price, v: p.volume };
    } else {
      current.h = Math.max(current.h, p.price);
      current.l = Math.min(current.l, p.price);
      current.c = p.price;
      current.v += p.volume;
    }
  }
  if (current) candles.push(current);
  return candles;
}

export interface CandleSets {
  h1: Candle[];
  h4: Candle[];
  d1: Candle[];
}

/** Assembles the multi-timeframe candle payload the analysis agent consumes. */
export function buildCandleSets(token: string, nowSec = Math.floor(Date.now() / 1000)): CandleSets {
  const sets = {} as CandleSets;
  for (const name of Object.keys(TIMEFRAMES) as TimeframeName[]) {
    const { seconds, maxCandles } = LOOKBACK[name];
    const points = getPricePoints(token, nowSec - seconds, nowSec);
    const candles = aggregateCandles(points, TIMEFRAMES[name]);
    sets[name] = candles.slice(-maxCandles);
  }
  return sets;
}
