import type { PublicClient } from "viem";
import { robinhoodChain, robinhoodClient } from "./chains.js";

export { robinhoodChain };

/** Robinhood Chain client — kept as a named export for the home-chain paths. */
export const publicClient: PublicClient = robinhoodClient;
