import type { Address } from "viem";
import { publicClient } from "../chain/clients.js";
import { config } from "../config.js";
import { CHAINLINK_AGGREGATOR_ABI, ERC8056_ABI } from "../chain/abis.js";
import { logger } from "../logger.js";

export interface PriceReading {
  price: number;
  updatedAt: Date;
  roundId: bigint;
}

export class StalePriceError extends Error {}
export class OraclePausedError extends Error {}
export class SequencerDownError extends Error {}

/** Post-outage grace period during which prices are still distrusted (per Chainlink
 *  L2 guidance): feeds may not have caught up immediately after the sequencer
 *  recovers. */
const SEQUENCER_GRACE_PERIOD_SEC = 3_600;

/**
 * Robinhood Chain is an Arbitrum L2 — during a sequencer outage feeds go stale
 * while looking fresh. When a sequencer uptime feed is configured we refuse to
 * trust any price while the sequencer is down or has only just recovered.
 * Unconfigured (address not yet published), this check is skipped and staleness
 * remains the only guard — set SEQUENCER_UPTIME_FEED as soon as it's known.
 */
export async function assertSequencerUp(): Promise<void> {
  if (!config.SEQUENCER_UPTIME_FEED) return;

  const [, answer, startedAt] = await publicClient.readContract({
    address: config.SEQUENCER_UPTIME_FEED as Address,
    abi: CHAINLINK_AGGREGATOR_ABI,
    functionName: "latestRoundData",
  });

  if (answer !== 0n) {
    throw new SequencerDownError("L2 sequencer is down — refusing to trust any price");
  }
  const sinceUp = Date.now() / 1000 - Number(startedAt);
  if (sinceUp < SEQUENCER_GRACE_PERIOD_SEC) {
    throw new SequencerDownError(
      `L2 sequencer recovered only ${Math.floor(sinceUp)}s ago (grace ${SEQUENCER_GRACE_PERIOD_SEC}s)`,
    );
  }
}

/**
 * Reads a stock token's Chainlink feed with the full battery of Robinhood Chain
 * checks: sequencer uptime, the token's advisory oraclePaused() flag (corporate
 * actions pause the feed), positive answer, and staleness. The feed price already
 * includes the ERC-8056 corporate-action multiplier — never re-apply it.
 */
export async function readStockTokenPrice(
  token: Address,
  feed: Address,
  maxStalenessSec = config.CHAINLINK_MAX_STALENESS_SEC,
): Promise<PriceReading> {
  await assertSequencerUp();

  const [roundData, decimals, paused] = await Promise.all([
    publicClient.readContract({
      address: feed,
      abi: CHAINLINK_AGGREGATOR_ABI,
      functionName: "latestRoundData",
    }),
    publicClient.readContract({
      address: feed,
      abi: CHAINLINK_AGGREGATOR_ABI,
      functionName: "decimals",
    }),
    publicClient
      .readContract({ address: token, abi: ERC8056_ABI, functionName: "oraclePaused" })
      .catch(() => false), // advisory flag; absence of the getter is not fatal
  ]);

  if (paused) {
    throw new OraclePausedError(
      `oracle for ${token} is paused (corporate action in progress) — price temporarily unavailable`,
    );
  }

  const [roundId, answer, , updatedAt] = roundData;

  if (answer <= 0n) {
    throw new StalePriceError(`feed ${feed} returned non-positive answer: ${answer}`);
  }

  const ageSec = Date.now() / 1000 - Number(updatedAt);
  if (ageSec > maxStalenessSec) {
    throw new StalePriceError(
      `feed ${feed} is stale: last updated ${ageSec.toFixed(0)}s ago (max ${maxStalenessSec}s). ` +
        `Note: stock feeds update 24/5 and pause outside market hours.`,
    );
  }

  const price = Number(answer) / 10 ** decimals;
  logger.debug({ token, feed, price }, "chainlink price read");

  return { price, updatedAt: new Date(Number(updatedAt) * 1000), roundId };
}
