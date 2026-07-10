import type { Address, PublicClient } from "viem";
import { config } from "../config.js";
import {
  evmClient,
  getChainDef,
  type ChainDef,
  type LjChainId,
} from "../chain/chains.js";
import { CHAINLINK_AGGREGATOR_ABI, ERC20_ABI, UNIV2_FACTORY_ABI, UNIV2_PAIR_ABI } from "../chain/abis.js";
import { readStockTokenPrice } from "../oracle/chainlink.js";
import { readPythPrice } from "../oracle/pyth.js";
import { MAJORS } from "../tokens/majors.js";
import { isEthQuoted, readLpSpotPrice, spotPriceFromReserves } from "../venues/uniswapV2.js";
import type { TokenInfo } from "../tokens/registry.js";

/**
 * Unified trusted price read for any tradable token, in its quote asset:
 * stock tokens → Chainlink (USD); LP tokens → pair reserves (chain quote asset);
 * majors → Pyth (USD). Trigger levels, SL/TP, and stored candles all live in
 * these same quote terms, so trigger evaluation always compares like with like.
 */
export async function readTrustedPrice(token: TokenInfo): Promise<number> {
  if (token.kind === "major") {
    const feedId = token.pythFeedId ?? MAJORS[token.symbol]?.pythFeedId;
    if (!feedId) throw new Error(`${token.symbol} has no Pyth feed id`);
    return readPythPrice(feedId);
  }
  if (token.kind === "stock") {
    if (!token.chainlinkFeed) {
      throw new Error(
        `${token.symbol} has no Chainlink feed configured — add it to config/chainlink-feeds.json ` +
          `(canonical list: docs.chain.link → Robinhood Chain price feeds)`,
      );
    }
    const reading = await readStockTokenPrice(
      token.address,
      token.chainlinkFeed,
      config.CHAINLINK_MAX_STALENESS_SEC,
      getChainDef(token.chain),
    );
    return reading.price;
  }
  return readLpSpotPrice(token);
}

const decimalsCache = new Map<string, number>();

export async function erc20Decimals(address: Address, chainId: LjChainId = "robinhood"): Promise<number> {
  const key = `${chainId}:${address.toLowerCase()}`;
  const cached = decimalsCache.get(key);
  if (cached !== undefined) return cached;
  const client = evmClient(getChainDef(chainId));
  const decimals = await client.readContract({ address, abi: ERC20_ABI, functionName: "decimals" });
  decimalsCache.set(key, decimals);
  return decimals;
}

export async function erc20Balance(
  address: Address,
  owner: Address,
  chainId: LjChainId = "robinhood",
): Promise<bigint> {
  const client = evmClient(getChainDef(chainId));
  return client.readContract({
    address,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [owner],
  });
}

const ethUsdCache = new Map<string, { price: number; at: number }>();
const ETH_USD_CACHE_MS = 30_000;

/**
 * ETH price in USD on a given chain — needed to size and value ETH-quoted
 * positions in the USD terms the user thinks in. Order of trust: the chain's
 * Chainlink ETH/USD feed, then the chain's USD/ETH Uniswap pair, then Pyth.
 */
export async function getEthUsdPrice(chainId: LjChainId = "robinhood"): Promise<number> {
  const cached = ethUsdCache.get(chainId);
  if (cached && Date.now() - cached.at < ETH_USD_CACHE_MS) return cached.price;

  const price = await readEthUsd(getChainDef(chainId));
  ethUsdCache.set(chainId, { price, at: Date.now() });
  return price;
}

async function readEthUsd(chain: ChainDef): Promise<number> {
  if (chain.kind === "evm" && chain.ethUsdFeed) {
    const client = evmClient(chain);
    const [, answer] = await client.readContract({
      address: chain.ethUsdFeed,
      abi: CHAINLINK_AGGREGATOR_ABI,
      functionName: "latestRoundData",
    });
    const decimals = await client.readContract({
      address: chain.ethUsdFeed,
      abi: CHAINLINK_AGGREGATOR_ABI,
      functionName: "decimals",
    });
    if (answer > 0n) return Number(answer) / 10 ** decimals;
  }

  if (chain.kind === "evm" && chain.univ2Factory && chain.ethQuote && chain.usdQuote) {
    const client: PublicClient = evmClient(chain);
    const pair = await client.readContract({
      address: chain.univ2Factory,
      abi: UNIV2_FACTORY_ABI,
      functionName: "getPair",
      args: [chain.ethQuote.address, chain.usdQuote.address],
    });
    if (pair !== "0x0000000000000000000000000000000000000000") {
      const [token0, reserves, usdDecimals] = await Promise.all([
        client.readContract({ address: pair, abi: UNIV2_PAIR_ABI, functionName: "token0" }),
        client.readContract({ address: pair, abi: UNIV2_PAIR_ABI, functionName: "getReserves" }),
        erc20Decimals(chain.usdQuote.address, chain.id),
      ]);
      const ethIsToken0 = token0.toLowerCase() === chain.ethQuote.address.toLowerCase();
      const ethReserve = ethIsToken0 ? reserves[0] : reserves[1];
      const usdReserve = ethIsToken0 ? reserves[1] : reserves[0];
      const price = spotPriceFromReserves(ethReserve, usdReserve, 18, usdDecimals);
      if (price > 0) return price;
    }
  }

  // Universal fallback: Pyth ETH/USD (also the only source on Solana).
  const ethFeed = MAJORS.ETH;
  if (!ethFeed) throw new Error("ETH is missing from the majors registry");
  return readPythPrice(ethFeed.pythFeedId);
}

export { isEthQuoted };
