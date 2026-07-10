import "./setupEnv.js";
import { describe, expect, it } from "vitest";
import { aggregateCandles, type PricePoint } from "../src/candles/store.js";
import { swapToPricePoint } from "../src/candles/backfill.js";
import {
  getAmountOut,
  minOutWithSlippage,
  quoteExactIn,
  spotPriceFromReserves,
} from "../src/venues/uniswapV2.js";
import { rankCandidates, type BlockscoutToken } from "../src/tokens/blockscout.js";

describe("aggregateCandles", () => {
  const H1 = 3600;

  it("builds OHLCV per bucket from ordered points", () => {
    const points: PricePoint[] = [
      { t: 7200, price: 10, volume: 1 },
      { t: 7800, price: 12, volume: 2 },
      { t: 8000, price: 9, volume: 1 },
      { t: 10_799, price: 11, volume: 3 }, // still bucket 7200
      { t: 10_800, price: 11.5, volume: 5 }, // next bucket
    ];
    const candles = aggregateCandles(points, H1);
    expect(candles).toHaveLength(2);
    expect(candles[0]).toEqual({ t: 7200, o: 10, h: 12, l: 9, c: 11, v: 7 });
    expect(candles[1]).toEqual({ t: 10_800, o: 11.5, h: 11.5, l: 11.5, c: 11.5, v: 5 });
  });

  it("leaves gaps as gaps rather than inventing flat candles", () => {
    const points: PricePoint[] = [
      { t: 0, price: 1, volume: 0 },
      { t: 4 * H1, price: 2, volume: 0 }, // 3 empty buckets between
    ];
    const candles = aggregateCandles(points, H1);
    expect(candles.map((c) => c.t)).toEqual([0, 4 * H1]);
  });

  it("returns empty for no points", () => {
    expect(aggregateCandles([], H1)).toEqual([]);
  });
});

describe("uniswap v2 math", () => {
  it("spot price respects decimals", () => {
    // 1000 tokens (18dp) vs 5000 USDG (6dp) → 5 USDG per token
    expect(spotPriceFromReserves(1000n * 10n ** 18n, 5000n * 10n ** 6n, 18, 6)).toBe(5);
  });

  it("getAmountOut applies the 0.3% fee", () => {
    const out = getAmountOut(1n * 10n ** 18n, 100n * 10n ** 18n, 100n * 10n ** 18n);
    // ~0.987 out for 1 in on a balanced 100/100 pool
    expect(Number(out) / 1e18).toBeCloseTo(0.9871, 3);
  });

  it("quoteExactIn reports growing price impact with size", () => {
    const r = (n: number) => BigInt(n) * 10n ** 18n;
    const small = quoteExactIn(r(1), r(1000), r(1000), 18, 18);
    const large = quoteExactIn(r(100), r(1000), r(1000), 18, 18);
    expect(small.priceImpactBps).toBeLessThan(large.priceImpactBps);
    expect(large.priceImpactBps).toBeGreaterThan(500); // 10% of pool ≫ 5%
  });

  it("minOutWithSlippage floors correctly", () => {
    expect(minOutWithSlippage(10_000n, 100)).toBe(9_900n); // 1%
    expect(minOutWithSlippage(10_000n, 0)).toBe(10_000n);
  });
});

describe("swapToPricePoint", () => {
  const D18 = 10n ** 18n;
  const D6 = 10n ** 6n;

  it("derives price from a buy (quote in, base out)", () => {
    const point = swapToPricePoint(
      { amount0In: 0n, amount1In: 500n * D6, amount0Out: 100n * D18, amount1Out: 0n },
      true, // base is token0
      18,
      6,
    );
    expect(point).not.toBeNull();
    expect(point!.price).toBeCloseTo(5); // 500 USDG for 100 tokens
    expect(point!.volume).toBeCloseTo(500);
  });

  it("derives price from a sell (base in, quote out)", () => {
    const point = swapToPricePoint(
      { amount0In: 100n * D18, amount1In: 0n, amount0Out: 0n, amount1Out: 480n * D6 },
      true,
      18,
      6,
    );
    expect(point!.price).toBeCloseTo(4.8);
    expect(point!.volume).toBeCloseTo(480);
  });

  it("handles base as token1", () => {
    const point = swapToPricePoint(
      { amount0In: 500n * D6, amount1In: 0n, amount0Out: 0n, amount1Out: 100n * D18 },
      false, // base is token1
      18,
      6,
    );
    expect(point!.price).toBeCloseTo(5);
  });

  it("returns null for degenerate events", () => {
    expect(
      swapToPricePoint({ amount0In: 0n, amount1In: 0n, amount0Out: 0n, amount1Out: 0n }, true, 18, 6),
    ).toBeNull();
  });
});

describe("rankCandidates", () => {
  const base: BlockscoutToken = {
    address: "0x0000000000000000000000000000000000000001",
    symbol: "PEPE",
    name: "Pepe",
    decimals: 18,
    holders: 100,
    circulatingMarketCapUsd: null,
    volumeUsd: null,
  };

  it("ranks by market cap first", () => {
    const small = { ...base, address: "0x0000000000000000000000000000000000000002", circulatingMarketCapUsd: 1_000 };
    const big = { ...base, address: "0x0000000000000000000000000000000000000003", circulatingMarketCapUsd: 9_000_000 };
    expect(rankCandidates("pepe", [small, big])[0]).toBe(big);
  });

  it("prefers exact symbol matches over larger fuzzy matches", () => {
    const exact = { ...base, symbol: "PEPE", circulatingMarketCapUsd: 1_000 };
    const fuzzy = {
      ...base,
      address: "0x0000000000000000000000000000000000000004",
      symbol: "PEPE2",
      name: "Pepe Two",
      circulatingMarketCapUsd: 9_000_000,
    };
    expect(rankCandidates("PEPE", [fuzzy, exact])[0]).toBe(exact);
  });

  it("falls back to volume then holders when MC ties", () => {
    const lowVol = { ...base, address: "0x0000000000000000000000000000000000000005", volumeUsd: 10 };
    const highVol = { ...base, address: "0x0000000000000000000000000000000000000006", volumeUsd: 500 };
    expect(rankCandidates("pepe", [lowVol, highVol])[0]).toBe(highVol);

    const fewHolders = { ...base, address: "0x0000000000000000000000000000000000000007", holders: 5 };
    const manyHolders = { ...base, address: "0x0000000000000000000000000000000000000008", holders: 5_000 };
    expect(rankCandidates("pepe", [fewHolders, manyHolders])[0]).toBe(manyHolders);
  });
});
