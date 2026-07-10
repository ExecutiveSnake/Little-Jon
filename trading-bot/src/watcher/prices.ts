import type { Address } from "viem";
import { config } from "../config.js";
import { publicClient } from "../chain/clients.js";
import { CHAINLINK_AGGREGATOR_ABI, ERC20_ABI, UNIV2_FACTORY_ABI, UNIV2_PAIR_ABI } from "../chain/abis.js";
import { readStockTokenPrice } from "../oracle/chainlink.js";
import { readLpSpotPrice, spotPriceFromReserves } from "../venues/uniswapV2.js";
import type { TokenInfo } from "../tokens/registry.js";

/**
 * Unified trusted price read for any tradable token, in its quote asset:
 * stock tokens → Chainlink (USD); LP tokens → pair reserves (USDG or rhETH).
 * Trigger levels, SL/TP, and stored candles all live in these same quote terms,
 * so trigger evaluation always compares like with like.
 */
export async function readTrustedPrice(token: TokenInfo): Promise<number> {
  if (token.kind === "stock") {
    if (!token.chainlinkFeed) {
      throw new Error(
        `${token.symbol} has no Chainlink feed configured — add it to config/chainlink-feeds.json ` +
          `(canonical list: docs.chain.link → Robinhood Chain price feeds)`,
      );
    }
    const reading = await readStockTokenPrice(token.address, token.chainlinkFeed);
    return reading.price;
  }
  return readLpSpotPrice(token);
}

const decimalsCache = new Map<string, number>();

export async function erc20Decimals(address: Address): Promise<number> {
  const key = address.toLowerCase();
  const cached = decimalsCache.get(key);
  if (cached !== undefined) return cached;
  const decimals = await publicClient.readContract({ address, abi: ERC20_ABI, functionName: "decimals" });
  decimalsCache.set(key, decimals);
  return decimals;
}

export async function erc20Balance(address: Address, owner: Address): Promise<bigint> {
  return publicClient.readContract({
    address,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [owner],
  });
}

/**
 * ETH price in USD — needed to size and value rhETH-quoted positions in the USD
 * terms the user thinks in. Prefers the Chainlink ETH/USD feed; falls back to the
 * USDG/rhETH Uniswap pair when no feed address is configured yet.
 */
export async function getEthUsdPrice(): Promise<number> {
  if (config.ETH_USD_FEED) {
    const [, answer, , ,] = await publicClient.readContract({
      address: config.ETH_USD_FEED as Address,
      abi: CHAINLINK_AGGREGATOR_ABI,
      functionName: "latestRoundData",
    });
    const decimals = await publicClient.readContract({
      address: config.ETH_USD_FEED as Address,
      abi: CHAINLINK_AGGREGATOR_ABI,
      functionName: "decimals",
    });
    if (answer > 0n) return Number(answer) / 10 ** decimals;
  }

  if (config.UNIV2_FACTORY_ADDRESS) {
    const pair = await publicClient.readContract({
      address: config.UNIV2_FACTORY_ADDRESS as Address,
      abi: UNIV2_FACTORY_ABI,
      functionName: "getPair",
      args: [config.RHETH_ADDRESS as Address, config.USDG_ADDRESS as Address],
    });
    if (pair !== "0x0000000000000000000000000000000000000000") {
      const [token0, reserves, usdgDecimals] = await Promise.all([
        publicClient.readContract({ address: pair, abi: UNIV2_PAIR_ABI, functionName: "token0" }),
        publicClient.readContract({ address: pair, abi: UNIV2_PAIR_ABI, functionName: "getReserves" }),
        erc20Decimals(config.USDG_ADDRESS as Address),
      ]);
      const ethIsToken0 = token0.toLowerCase() === config.RHETH_ADDRESS.toLowerCase();
      const ethReserve = ethIsToken0 ? reserves[0] : reserves[1];
      const usdgReserve = ethIsToken0 ? reserves[1] : reserves[0];
      const price = spotPriceFromReserves(ethReserve, usdgReserve, 18, usdgDecimals);
      if (price > 0) return price;
    }
  }

  throw new Error(
    "cannot determine ETH/USD price — set ETH_USD_FEED (Chainlink) or UNIV2_FACTORY_ADDRESS " +
      "(USDG/rhETH pair fallback)",
  );
}
