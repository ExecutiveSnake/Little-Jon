import { type Address } from "viem";
import { publicClient } from "../chain/clients.js";
import { logger } from "../logger.js";

// Standard Chainlink AggregatorV3Interface — Robinhood Chain Stock Token feeds are
// expected to expose this same interface (confirm against the actual deployed feed
// before going live).
const AGGREGATOR_V3_ABI = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

export interface PriceReading {
  price: number; // normalized to a plain decimal float, e.g. 189.42
  updatedAt: Date;
  roundId: bigint;
}

export class StalePriceError extends Error {}

/**
 * Reads the latest price from a Chainlink-compatible feed for a Robinhood Chain Stock
 * Token, rejecting stale or non-positive answers. Never trade off a price that fails
 * this check.
 *
 * @param feedAddress Address of the AggregatorV3Interface feed for the target symbol.
 * @param maxStalenessSeconds Reject the reading if `updatedAt` is older than this.
 */
export async function readStockTokenPrice(
  feedAddress: Address,
  maxStalenessSeconds = 3600,
): Promise<PriceReading> {
  const [roundData, decimals] = await Promise.all([
    publicClient.readContract({
      address: feedAddress,
      abi: AGGREGATOR_V3_ABI,
      functionName: "latestRoundData",
    }),
    publicClient.readContract({
      address: feedAddress,
      abi: AGGREGATOR_V3_ABI,
      functionName: "decimals",
    }),
  ]);

  const [roundId, answer, , updatedAt] = roundData;

  if (answer <= 0n) {
    throw new StalePriceError(`feed ${feedAddress} returned non-positive answer: ${answer}`);
  }

  const updatedAtDate = new Date(Number(updatedAt) * 1000);
  const ageSeconds = Date.now() / 1000 - Number(updatedAt);
  if (ageSeconds > maxStalenessSeconds) {
    throw new StalePriceError(
      `feed ${feedAddress} is stale: last updated ${ageSeconds.toFixed(0)}s ago (max ${maxStalenessSeconds}s)`,
    );
  }

  const price = Number(answer) / 10 ** decimals;

  logger.debug({ feedAddress, price, updatedAt: updatedAtDate.toISOString() }, "read Chainlink price");

  return { price, updatedAt: updatedAtDate, roundId };
}
