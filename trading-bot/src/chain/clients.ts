import { createPublicClient, defineChain, http, type PublicClient } from "viem";
import { config } from "../config.js";

/**
 * Robinhood Chain (an Arbitrum Orbit L2, per docs.robinhood.com/chain).
 * Chain ID 4663 mainnet / 46630 testnet; ETH is the native gas token.
 */
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

export const publicClient: PublicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(config.CHAIN_RPC_URL),
});
