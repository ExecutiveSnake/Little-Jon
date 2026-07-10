import { createPublicClient, defineChain, http, type Address, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { config } from "../config.js";

/**
 * Little Jon's chain registry.
 *
 *  - robinhood — home chain: stock tokens (ERC-8056 + Chainlink + 0x RFQ),
 *    LP tokens (Uniswap V2), majors.
 *  - ethereum  — full EVM support: LP tokens on canonical Uniswap V2, majors
 *    executed through their wrapped forms (WETH/WBTC ↔ USDC).
 *  - solana    — majors only, priced and watched via Pyth. No execution venue
 *    is wired yet, so major positions there run in labeled PAPER mode.
 */

export type LjChainId = "robinhood" | "ethereum" | "solana";

export interface EvmQuote {
  symbol: string;
  address: Address;
}

export interface ChainDef {
  id: LjChainId;
  kind: "evm" | "solana";
  displayName: string;
  /** viem client — EVM chains only. */
  client?: PublicClient;
  blockscoutApiUrl?: string;
  univ2Factory?: Address;
  univ2Router?: Address;
  /** USD-stable settlement quote for LP pairs (USDG / USDC). */
  usdQuote?: EvmQuote;
  /** ETH-side quote for LP pairs (rhETH / WETH). */
  ethQuote?: EvmQuote;
  sequencerUptimeFeed?: Address;
  ethUsdFeed?: Address;
  /** Wrapped ERC-20 forms of major assets, for real execution of major-class
   *  positions on this chain (e.g. ETH→WETH, BTC→WBTC). */
  wrappedMajors: Record<string, Address>;
  /** Whether this chain has an execution venue wired. */
  canExecute: boolean;
}

export const robinhoodChain = defineChain({
  id: config.CHAIN_ID,
  name: config.CHAIN_ID === 4663 ? "Robinhood Chain" : "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [config.CHAIN_RPC_URL] },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url:
        config.CHAIN_ID === 4663
          ? "https://robinhoodchain.blockscout.com"
          : "https://explorer.testnet.chain.robinhood.com",
    },
  },
  contracts: {
    multicall3: { address: config.MULTICALL3_ADDRESS as `0x${string}` },
  },
});

export const robinhoodClient: PublicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(config.CHAIN_RPC_URL),
});

const ethereumClient: PublicClient = createPublicClient({
  chain: mainnet,
  transport: http(config.ETHEREUM_RPC_URL),
});

const REGISTRY: Record<LjChainId, ChainDef> = {
  robinhood: {
    id: "robinhood",
    kind: "evm",
    displayName: config.CHAIN_ID === 4663 ? "Robinhood Chain" : "Robinhood Testnet",
    client: robinhoodClient,
    blockscoutApiUrl: config.BLOCKSCOUT_API_URL,
    univ2Factory: config.UNIV2_FACTORY_ADDRESS as Address | undefined,
    univ2Router: config.UNIV2_ROUTER_ADDRESS as Address | undefined,
    usdQuote: { symbol: "USDG", address: config.USDG_ADDRESS as Address },
    ethQuote: { symbol: "rhETH", address: config.RHETH_ADDRESS as Address },
    sequencerUptimeFeed: config.SEQUENCER_UPTIME_FEED as Address | undefined,
    ethUsdFeed: config.ETH_USD_FEED as Address | undefined,
    wrappedMajors: { ETH: config.RHETH_ADDRESS as Address },
    canExecute: true,
  },
  ethereum: {
    id: "ethereum",
    kind: "evm",
    displayName: "Ethereum",
    client: ethereumClient,
    blockscoutApiUrl: config.ETHEREUM_BLOCKSCOUT_API_URL,
    univ2Factory: config.ETHEREUM_UNIV2_FACTORY as Address,
    univ2Router: config.ETHEREUM_UNIV2_ROUTER as Address,
    usdQuote: { symbol: "USDC", address: config.ETHEREUM_USDC_ADDRESS as Address },
    ethQuote: { symbol: "WETH", address: config.ETHEREUM_WETH_ADDRESS as Address },
    // Ethereum is the L1 — no sequencer uptime feed applies.
    ethUsdFeed: config.ETHEREUM_ETH_USD_FEED as Address,
    wrappedMajors: {
      ETH: config.ETHEREUM_WETH_ADDRESS as Address,
      BTC: config.ETHEREUM_WBTC_ADDRESS as Address,
    },
    canExecute: true,
  },
  solana: {
    id: "solana",
    kind: "solana",
    displayName: "Solana",
    wrappedMajors: {},
    canExecute: false,
  },
};

const enabled = new Set(
  config.ENABLED_CHAINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

export const DEFAULT_CHAIN: LjChainId = "robinhood";

export function listChains(): ChainDef[] {
  return Object.values(REGISTRY).filter((c) => enabled.has(c.id));
}

export function getChainDef(id: string): ChainDef {
  const def = REGISTRY[id as LjChainId];
  if (!def || !enabled.has(def.id)) {
    throw new Error(
      `unknown or disabled chain "${id}" — enabled: ${[...enabled].join(", ")}`,
    );
  }
  return def;
}

export function evmClient(chain: ChainDef): PublicClient {
  if (!chain.client) throw new Error(`${chain.id} is not an EVM chain`);
  return chain.client;
}
