import type { LjChainId } from "../chain/chains.js";
import type { TokenInfo } from "./registry.js";

/**
 * Major assets tradable by oracle price on any chain. Prices come straight from
 * Pyth (Crypto.<SYM>/USD feeds — the ids below are the published stable-channel
 * ids), history from Pyth Benchmarks. A major position executes through the
 * chain's wrapped form when one is configured (ETH→rhETH/WETH, BTC→WBTC);
 * otherwise it runs in labeled PAPER mode.
 */
export const MAJORS: Record<string, { name: string; pythFeedId: string }> = {
  ETH: { name: "Ethereum", pythFeedId: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" },
  SOL: { name: "Solana", pythFeedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d" },
  BTC: { name: "Bitcoin", pythFeedId: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43" },
  DOGE: { name: "Dogecoin", pythFeedId: "dcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c" },
  LINK: { name: "Chainlink", pythFeedId: "8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221" },
  UNI: { name: "Uniswap", pythFeedId: "78d185a741d07edb3412b09008b7c5cfb9bbbd7d568bf00ba737b456ba171501" },
  AAVE: { name: "Aave", pythFeedId: "2b9ab1e972a281585084148ba1389800799bd4be63b957507db1349314e47445" },
  PEPE: { name: "Pepe", pythFeedId: "d69731a2e74ac1ce884fc3890f7ee324b6deb66147055249568869ed700882e4" },
  BONK: { name: "Bonk", pythFeedId: "72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419" },
  JUP: { name: "Jupiter", pythFeedId: "0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996" },
};

export const MAJOR_KEY_PREFIX = "major:";

export function majorKey(symbol: string): string {
  return `${MAJOR_KEY_PREFIX}${symbol.toUpperCase()}`;
}

export function isMajorKey(key: string): boolean {
  return key.startsWith(MAJOR_KEY_PREFIX);
}

export function lookupMajor(input: string): string | null {
  const sym = input.trim().toUpperCase();
  return MAJORS[sym] ? sym : null;
}

/** Synthetic TokenInfo for a major asset on a given chain. Candles/prices are
 *  keyed chain-independently (`major:SOL`) — the oracle price is the same
 *  everywhere; the chain matters only for execution venue. */
export function majorToken(symbol: string, chain: LjChainId): TokenInfo {
  const sym = symbol.toUpperCase();
  const major = MAJORS[sym];
  if (!major) throw new Error(`${symbol} is not a supported major asset`);
  return {
    chain,
    key: majorKey(sym),
    address: "0x0000000000000000000000000000000000000000",
    symbol: sym,
    name: major.name,
    decimals: 18,
    kind: "major",
    pairAddress: null,
    pairedWith: "USD",
    chainlinkFeed: null,
    pythFeedId: major.pythFeedId,
  };
}

export function majorFromKey(key: string, chain: LjChainId): TokenInfo | undefined {
  if (!isMajorKey(key)) return undefined;
  const sym = key.slice(MAJOR_KEY_PREFIX.length).toUpperCase();
  return MAJORS[sym] ? majorToken(sym, chain) : undefined;
}
