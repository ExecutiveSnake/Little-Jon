import { createPublicClient, defineChain, http } from "viem";
import { config } from "../config.js";

// Robinhood Chain isn't in viem's built-in chain list yet, so it's defined inline.
// Replace name/nativeCurrency/block explorer with the real published values — see
// README for where to find them once Robinhood Chain testnet docs are public.
export const robinhoodChain = defineChain({
  id: config.CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [config.CHAIN_RPC_URL] },
  },
});

export const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(config.CHAIN_RPC_URL),
});
