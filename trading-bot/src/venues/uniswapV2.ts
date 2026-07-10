import { encodeFunctionData, type Address, type Hex } from "viem";
import { config } from "../config.js";
import { evmClient, getChainDef, type EvmQuote } from "../chain/chains.js";
import { ERC20_ABI, UNIV2_PAIR_ABI, UNIV2_ROUTER_ABI } from "../chain/abis.js";
import type { TokenInfo } from "../tokens/registry.js";

/** The quote asset (address + symbol) an LP token trades against, per its chain. */
export function quoteAssetFor(token: TokenInfo): EvmQuote {
  const chain = getChainDef(token.chain);
  for (const quote of [chain.usdQuote, chain.ethQuote]) {
    if (quote && quote.symbol === token.pairedWith) return quote;
  }
  throw new VenueUnavailableError(
    `${token.symbol} is quoted in ${token.pairedWith}, which is not a configured quote asset on ${chain.displayName}`,
  );
}

/** True when the token's LP quote is the chain's ETH-side asset (rhETH/WETH). */
export function isEthQuoted(token: TokenInfo): boolean {
  const chain = getChainDef(token.chain);
  return token.pairedWith !== null && token.pairedWith === chain.ethQuote?.symbol;
}

/**
 * Uniswap V2 venue adapter for graduated/LP'd tokens. Prices come from pair
 * reserves; execution goes through the standard V2 router (address env-gated until
 * Robinhood Chain's deployment is published).
 */

export class VenueUnavailableError extends Error {}

// ---------------------------------------------------------------------------
// Pure math (unit-tested)
// ---------------------------------------------------------------------------

/** Mid/spot price of base in quote terms from raw reserves. */
export function spotPriceFromReserves(
  baseReserve: bigint,
  quoteReserve: bigint,
  baseDecimals: number,
  quoteDecimals: number,
): number {
  if (baseReserve === 0n) return 0;
  return (
    Number(quoteReserve) / 10 ** quoteDecimals / (Number(baseReserve) / 10 ** baseDecimals)
  );
}

/** Constant-product output for an exact input, with the canonical 0.3% V2 fee. */
export function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInWithFee = amountIn * 997n;
  return (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee);
}

/** Effective execution price and price impact (bps vs. spot) for an exact-in swap. */
export function quoteExactIn(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  decimalsIn: number,
  decimalsOut: number,
): { amountOut: bigint; executionPrice: number; priceImpactBps: number } {
  const amountOut = getAmountOut(amountIn, reserveIn, reserveOut);
  const inFloat = Number(amountIn) / 10 ** decimalsIn;
  const outFloat = Number(amountOut) / 10 ** decimalsOut;
  const executionPrice = outFloat === 0 ? 0 : inFloat / outFloat; // in per out
  const spot =
    Number(reserveIn) / 10 ** decimalsIn / (Number(reserveOut) / 10 ** decimalsOut);
  const priceImpactBps = spot === 0 ? 0 : Math.max(0, (executionPrice / spot - 1) * 10_000);
  return { amountOut, executionPrice, priceImpactBps };
}

/** amountOutMin for a given slippage tolerance in bps. */
export function minOutWithSlippage(amountOut: bigint, slippageBps: number): bigint {
  return (amountOut * BigInt(10_000 - Math.floor(slippageBps))) / 10_000n;
}

// ---------------------------------------------------------------------------
// Live reads
// ---------------------------------------------------------------------------

export interface PairState {
  pair: Address;
  baseReserve: bigint;
  quoteReserve: bigint;
  baseIsToken0: boolean;
  quoteDecimals: number;
}

const pairMetaCache = new Map<string, { baseIsToken0: boolean; quoteDecimals: number }>();

export async function readPairState(token: TokenInfo): Promise<PairState> {
  if (!token.pairAddress || !token.pairedWith) {
    throw new VenueUnavailableError(`${token.symbol} has no LP pair recorded`);
  }
  const pair = token.pairAddress;
  const client = evmClient(getChainDef(token.chain));
  const quoteAddr = quoteAssetFor(token).address;

  let meta = pairMetaCache.get(pair);
  if (!meta) {
    const [token0, quoteDecimals] = await Promise.all([
      client.readContract({ address: pair, abi: UNIV2_PAIR_ABI, functionName: "token0" }),
      client.readContract({ address: quoteAddr, abi: ERC20_ABI, functionName: "decimals" }),
    ]);
    meta = { baseIsToken0: token0.toLowerCase() === token.address.toLowerCase(), quoteDecimals };
    pairMetaCache.set(pair, meta);
  }

  const [reserve0, reserve1] = await client.readContract({
    address: pair,
    abi: UNIV2_PAIR_ABI,
    functionName: "getReserves",
  });

  return {
    pair,
    baseReserve: meta.baseIsToken0 ? reserve0 : reserve1,
    quoteReserve: meta.baseIsToken0 ? reserve1 : reserve0,
    baseIsToken0: meta.baseIsToken0,
    quoteDecimals: meta.quoteDecimals,
  };
}

/** Current spot price of an LP token in its quote asset (USDG or rhETH). */
export async function readLpSpotPrice(token: TokenInfo): Promise<number> {
  const state = await readPairState(token);
  return spotPriceFromReserves(
    state.baseReserve,
    state.quoteReserve,
    token.decimals,
    state.quoteDecimals,
  );
}

// ---------------------------------------------------------------------------
// Swap calldata
// ---------------------------------------------------------------------------

export interface SwapPlan {
  router: Address;
  calls: { to: Address; value: bigint; data: Hex }[];
  amountIn: bigint;
  minAmountOut: bigint;
  expectedOut: bigint;
  priceImpactBps: number;
}

/**
 * Builds the approve + swapExactTokensForTokens call pair for an LP-token trade.
 * direction "buy": quote → token; "sell": token → quote. The caller (execution
 * layer) submits both calls as one batched UserOperation via the smart account,
 * and the session-key policy must allowlist exactly this router + the two token
 * approve targets.
 */
export async function buildLpSwap(
  token: TokenInfo,
  direction: "buy" | "sell",
  amountIn: bigint,
  recipient: Address,
  slippageBps = config.MAX_SLIPPAGE_BPS,
  deadlineSec = 600,
): Promise<SwapPlan> {
  const chain = getChainDef(token.chain);
  if (!chain.univ2Router) {
    throw new VenueUnavailableError(
      `no Uniswap V2 router configured for ${chain.displayName} — ` +
        `set it once the deployment address is published.`,
    );
  }
  const router = chain.univ2Router;
  const quoteAddr = quoteAssetFor(token).address;

  const state = await readPairState(token);
  const [reserveIn, reserveOut, tokenIn, decimalsIn, decimalsOut] =
    direction === "buy"
      ? ([state.quoteReserve, state.baseReserve, quoteAddr, state.quoteDecimals, token.decimals] as const)
      : ([state.baseReserve, state.quoteReserve, token.address, token.decimals, state.quoteDecimals] as const);

  const { amountOut, priceImpactBps } = quoteExactIn(
    amountIn,
    reserveIn,
    reserveOut,
    decimalsIn,
    decimalsOut,
  );
  if (amountOut === 0n) {
    throw new VenueUnavailableError(`quote for ${token.symbol} returned zero output`);
  }
  const minAmountOut = minOutWithSlippage(amountOut, slippageBps);

  const path: Address[] =
    direction === "buy" ? [quoteAddr, token.address] : [token.address, quoteAddr];

  const approveData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [router, amountIn],
  });
  const swapData = encodeFunctionData({
    abi: UNIV2_ROUTER_ABI,
    functionName: "swapExactTokensForTokens",
    args: [
      amountIn,
      minAmountOut,
      path,
      recipient,
      BigInt(Math.floor(Date.now() / 1000) + deadlineSec),
    ],
  });

  return {
    router,
    calls: [
      { to: tokenIn, value: 0n, data: approveData },
      { to: router, value: 0n, data: swapData },
    ],
    amountIn,
    minAmountOut,
    expectedOut: amountOut,
    priceImpactBps,
  };
}
