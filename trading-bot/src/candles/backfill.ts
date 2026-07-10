import type { Address, PublicClient } from "viem";
import { publicClient } from "../chain/clients.js";
import { CHAINLINK_AGGREGATOR_ABI, UNIV2_PAIR_ABI } from "../chain/abis.js";
import { insertManyPricePoints, type PricePoint } from "./store.js";
import { logger } from "../logger.js";

/**
 * One-time history seeding, per the agreed design: pull what exists once, then the
 * watcher keeps indexing forward. Two sources, one per token class:
 *
 *  - Stock tokens: walk the Chainlink feed's past rounds backwards. This is the
 *    exact price the bot trades/stops against, with zero drift — but it only
 *    reaches back to the feed's first round.
 *  - LP tokens: replay the Uniswap V2 pair's Swap events. Every trade is on-chain,
 *    so this reconstructs the token's real traded price and volume.
 */

// ---------------------------------------------------------------------------
// Chainlink round-walk (stock tokens)
// ---------------------------------------------------------------------------

export async function backfillChainlink(
  token: Address,
  feed: Address,
  maxLookbackSec = 180 * 86_400,
  maxRounds = 5_000,
  storageKey: string = token,
  client: PublicClient = publicClient,
): Promise<number> {
  const [latest, decimals] = await Promise.all([
    client.readContract({
      address: feed,
      abi: CHAINLINK_AGGREGATOR_ABI,
      functionName: "latestRoundData",
    }),
    client.readContract({
      address: feed,
      abi: CHAINLINK_AGGREGATOR_ABI,
      functionName: "decimals",
    }),
  ]);

  const scale = 10 ** decimals;
  const cutoff = Math.floor(Date.now() / 1000) - maxLookbackSec;
  const points: PricePoint[] = [];

  let roundId = latest[0];
  for (let i = 0; i < maxRounds; i++) {
    let round;
    try {
      round = await client.readContract({
        address: feed,
        abi: CHAINLINK_AGGREGATOR_ABI,
        functionName: "getRoundData",
        args: [roundId],
      });
    } catch {
      break; // crossed a phase boundary or ran out of history
    }

    const [, answer, , updatedAt] = round;
    const t = Number(updatedAt);
    if (t === 0 || t < cutoff) break;
    if (answer > 0n) {
      points.push({ t, price: Number(answer) / scale, volume: 0 });
    }

    if (roundId === 0n) break;
    roundId = roundId - 1n;
  }

  insertManyPricePoints(storageKey, points, "chainlink-backfill");
  logger.info({ token, feed, rounds: points.length }, "chainlink backfill complete");
  return points.length;
}

// ---------------------------------------------------------------------------
// Uniswap V2 Swap replay (LP tokens)
// ---------------------------------------------------------------------------

export interface SwapAmounts {
  amount0In: bigint;
  amount1In: bigint;
  amount0Out: bigint;
  amount1Out: bigint;
}

/**
 * Pure: derives an execution price (quote per base) and quote volume from one V2
 * Swap event. Returns null for degenerate events (zero-fill, flash-swap patterns
 * with both sides zero on one axis).
 *
 * A V2 swap moves base one way and quote the other:
 *   buy  base: quote in  → base out ⇒ price = quoteIn / baseOut
 *   sell base: base in   → quote out ⇒ price = quoteOut / baseIn
 */
export function swapToPricePoint(
  amounts: SwapAmounts,
  baseIsToken0: boolean,
  baseDecimals: number,
  quoteDecimals: number,
): { price: number; volume: number } | null {
  const baseIn = baseIsToken0 ? amounts.amount0In : amounts.amount1In;
  const baseOut = baseIsToken0 ? amounts.amount0Out : amounts.amount1Out;
  const quoteIn = baseIsToken0 ? amounts.amount1In : amounts.amount0In;
  const quoteOut = baseIsToken0 ? amounts.amount1Out : amounts.amount0Out;

  const baseScale = 10 ** baseDecimals;
  const quoteScale = 10 ** quoteDecimals;

  if (quoteIn > 0n && baseOut > 0n) {
    const price = Number(quoteIn) / quoteScale / (Number(baseOut) / baseScale);
    return { price, volume: Number(quoteIn) / quoteScale };
  }
  if (baseIn > 0n && quoteOut > 0n) {
    const price = Number(quoteOut) / quoteScale / (Number(baseIn) / baseScale);
    return { price, volume: Number(quoteOut) / quoteScale };
  }
  return null;
}

export async function backfillUniv2(
  token: Address,
  pair: Address,
  baseDecimals: number,
  quoteDecimals: number,
  lookbackBlocks = 500_000n,
  chunkSize = 10_000n,
  storageKey: string = token,
  client: PublicClient = publicClient,
): Promise<number> {
  const token0 = await client.readContract({
    address: pair,
    abi: UNIV2_PAIR_ABI,
    functionName: "token0",
  });
  const baseIsToken0 = token0.toLowerCase() === token.toLowerCase();

  const latestBlock = await client.getBlockNumber();
  const fromBlock = latestBlock > lookbackBlocks ? latestBlock - lookbackBlocks : 0n;

  const blockTimestampCache = new Map<bigint, number>();
  async function blockTime(blockNumber: bigint): Promise<number> {
    const cached = blockTimestampCache.get(blockNumber);
    if (cached !== undefined) return cached;
    const block = await client.getBlock({ blockNumber });
    const t = Number(block.timestamp);
    blockTimestampCache.set(blockNumber, t);
    return t;
  }

  const points: PricePoint[] = [];

  for (let start = fromBlock; start <= latestBlock; start += chunkSize) {
    const end = start + chunkSize - 1n > latestBlock ? latestBlock : start + chunkSize - 1n;
    const logs = await client.getContractEvents({
      address: pair,
      abi: UNIV2_PAIR_ABI,
      eventName: "Swap",
      fromBlock: start,
      toBlock: end,
    });

    for (const log of logs) {
      const args = log.args as unknown as SwapAmounts;
      const derived = swapToPricePoint(args, baseIsToken0, baseDecimals, quoteDecimals);
      if (!derived) continue;
      points.push({ t: await blockTime(log.blockNumber), ...derived });
    }
  }

  insertManyPricePoints(storageKey, points, "univ2-backfill");
  logger.info({ token, pair, swaps: points.length }, "univ2 swap backfill complete");
  return points.length;
}
