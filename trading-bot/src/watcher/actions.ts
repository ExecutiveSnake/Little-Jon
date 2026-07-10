import type { Address } from "viem";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { getChainDef } from "../chain/chains.js";
import { classifyToken, type TokenInfo } from "../tokens/registry.js";
import { buildLpSwap, isEthQuoted, quoteAssetFor } from "../venues/uniswapV2.js";
import { fetchRfqQuote } from "../venues/rfq.js";
import { getExecutionBackend, type Call } from "../execution/backend.js";
import {
  markCancelled,
  markClosed,
  markOpen,
  type ExitReason,
  type Position,
} from "../positions/store.js";
import {
  assertPositionSizeAllowed,
  assertSafeToProposeTrade,
  assertSlippageAllowed,
  recordRealizedPnl,
  GuardrailViolation,
} from "../risk/guardrails.js";
import { notify } from "../notify/notifier.js";
import { erc20Balance, erc20Decimals, getEthUsdPrice } from "./prices.js";
import { encodeFunctionData } from "viem";
import { ERC20_ABI } from "../chain/abis.js";

/**
 * Entry/exit execution for the watcher. Every trade passes the full guardrail
 * battery immediately before submission, and every live exit is confirmed by the
 * settlement asset (USDG/rhETH) actually landing in the smart account — the
 * notification the user receives is based on that received balance, not on the
 * quote.
 */

function quoteAssetAddress(token: TokenInfo): Address {
  return quoteAssetFor(token).address;
}

/**
 * Major-class positions execute through the chain's wrapped ERC-20 form when
 * one is configured and LP-tradable (ETH→rhETH/WETH, BTC→WBTC). Returns null
 * when the chain has no venue for this major — the position then runs in
 * labeled PAPER mode (state + P&L tracked at oracle prices, nothing sent).
 */
const wrappedCache = new Map<string, TokenInfo | null>();
async function resolveExecutionToken(token: TokenInfo): Promise<TokenInfo | null> {
  if (token.kind !== "major") return token;
  const cacheKey = `${token.chain}:${token.symbol}`;
  const cached = wrappedCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const chain = getChainDef(token.chain);
  const wrapped = chain.wrappedMajors[token.symbol];
  let result: TokenInfo | null = null;
  if (chain.kind === "evm" && wrapped && chain.univ2Factory) {
    try {
      const info = await classifyToken(wrapped, chain);
      if (info.kind === "lp") result = info;
    } catch (err) {
      logger.warn(
        { err, symbol: token.symbol, chain: token.chain },
        "wrapped form of major is not LP-tradable — falling back to paper mode",
      );
    }
  }
  wrappedCache.set(cacheKey, result);
  return result;
}

/** Converts the user's USD size into quote-asset base units. */
export async function sizeToQuoteUnits(token: TokenInfo, sizeUsd: number): Promise<bigint> {
  const quote = quoteAssetAddress(token);
  const decimals = await erc20Decimals(quote, token.chain);
  if (token.kind === "lp" && isEthQuoted(token)) {
    const ethUsd = await getEthUsdPrice(token.chain);
    return BigInt(Math.floor((sizeUsd / ethUsd) * 10 ** decimals));
  }
  return BigInt(Math.floor(sizeUsd * 10 ** decimals)); // USD-stable quote ≈ USD
}

/** Converts quote-asset base units to USD for P&L accounting. */
export async function quoteUnitsToUsd(token: TokenInfo, amount: bigint): Promise<number> {
  const quote = quoteAssetAddress(token);
  const decimals = await erc20Decimals(quote, token.chain);
  const human = Number(amount) / 10 ** decimals;
  if (token.kind === "lp" && isEthQuoted(token)) {
    return human * (await getEthUsdPrice(token.chain));
  }
  return human;
}

interface PreparedTrade {
  calls: Call[];
  expectedOut: bigint;
  executionPrice: number; // quote per token
}

async function prepareTrade(
  token: TokenInfo,
  direction: "buy" | "sell",
  amountIn: bigint,
  referencePrice: number,
  recipient: Address,
): Promise<PreparedTrade> {
  if (token.kind === "stock") {
    const quote = await fetchRfqQuote(token, direction, amountIn, recipient);
    // RFQ has no pool slippage; guard the quote against the Chainlink reference
    // price instead so a bad/rogue quote can't fill far off oracle.
    assertSlippageAllowed(referencePrice, quote.price);
    const approve: Call = {
      to: quote.sellToken,
      value: 0n,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [quote.allowanceTarget, amountIn],
      }),
    };
    return {
      calls: [approve, { to: quote.to, value: quote.value, data: quote.data }],
      expectedOut: quote.buyAmount,
      executionPrice: quote.price,
    };
  }

  const plan = await buildLpSwap(token, direction, amountIn, recipient);
  if (plan.priceImpactBps > config.MAX_SLIPPAGE_BPS) {
    throw new GuardrailViolation(
      `price impact ${plan.priceImpactBps.toFixed(1)}bps exceeds max ${config.MAX_SLIPPAGE_BPS}bps ` +
        `(size too large for ${token.symbol} liquidity)`,
    );
  }
  const quoteDecimals = await erc20Decimals(quoteAssetAddress(token));
  const outHuman = Number(plan.expectedOut) / 10 ** (direction === "buy" ? token.decimals : quoteDecimals);
  const inHuman = Number(amountIn) / 10 ** (direction === "buy" ? quoteDecimals : token.decimals);
  const executionPrice = direction === "buy" ? inHuman / outHuman : outHuman / inHuman;
  assertSlippageAllowed(referencePrice, executionPrice);
  return { calls: plan.calls, expectedOut: plan.expectedOut, executionPrice };
}

export async function executeEntry(
  position: Position,
  token: TokenInfo,
  currentPrice: number,
): Promise<void> {
  try {
    assertSafeToProposeTrade();
    if (position.sizeUsd === null) throw new GuardrailViolation("position has no size set");
    assertPositionSizeAllowed(position.sizeUsd);

    const execToken = await resolveExecutionToken(token);

    if (execToken === null) {
      // PAPER mode: no venue for this major on this chain (e.g. SOL on Solana).
      // Track state and P&L at oracle prices; nothing goes on-chain.
      const amount = BigInt(Math.floor((position.sizeUsd / currentPrice) * 1e9));
      markOpen(position.id, currentPrice, amount.toString(), null);
      await notify(
        `entered ${token.symbol} (#${position.id}) — PAPER`,
        `no execution venue on ${getChainDef(token.chain).displayName} yet; tracking at oracle price ` +
          `$${position.sizeUsd} @ ${currentPrice.toFixed(6)} · SL ${position.stopLoss} · TP ${position.takeProfit}`,
      );
      return;
    }

    const backend = await getExecutionBackend();
    const account = await backend.accountAddress();
    const amountIn = await sizeToQuoteUnits(execToken, position.sizeUsd);

    const prepared = await prepareTrade(execToken, "buy", amountIn, currentPrice, account);

    const balanceBefore =
      backend.kind === "zerodev" ? await erc20Balance(execToken.address, account, execToken.chain) : 0n;

    const result = await backend.sendCalls(prepared.calls, `entry #${position.id} ${token.symbol}`);

    const received =
      backend.kind === "zerodev"
        ? (await erc20Balance(execToken.address, account, execToken.chain)) - balanceBefore
        : prepared.expectedOut;
    if (received <= 0n) {
      throw new Error(`entry executed but no ${execToken.symbol} received — investigate immediately`);
    }

    markOpen(position.id, prepared.executionPrice, received.toString(), result.txHash);
    await notify(
      `entered ${token.symbol} (#${position.id})`,
      `size $${position.sizeUsd} @ ${prepared.executionPrice.toFixed(6)} · ` +
        `SL ${position.stopLoss} · TP ${position.takeProfit}` +
        (result.dryRun ? " · DRY RUN" : ` · tx ${result.txHash}`),
    );
  } catch (err) {
    if (err instanceof GuardrailViolation) {
      // Guardrail rejections are structural (size/limits/kill switch) — cancel so
      // the watcher doesn't re-attempt a trade that can never pass.
      markCancelled(position.id);
      await notify(
        `entry cancelled ${token.symbol} (#${position.id})`,
        `guardrail: ${err.message}`,
      );
      return;
    }
    // Transient failures (RPC, venue) stay in awaiting_entry and retry next tick.
    logger.error({ err, positionId: position.id }, "entry attempt failed; will retry");
  }
}

export async function executeExit(
  position: Position,
  token: TokenInfo,
  currentPrice: number,
  reason: Extract<ExitReason, "tp" | "sl" | "manual">,
): Promise<void> {
  try {
    if (!position.amountToken) throw new Error("open position has no recorded token amount");
    const amountIn = BigInt(position.amountToken);

    const execToken = await resolveExecutionToken(token);

    if (execToken === null) {
      // PAPER close: P&L at oracle prices; deliberately NOT fed into the real
      // daily-loss circuit breaker.
      const entryPrice = position.entryPrice ?? currentPrice;
      const pnlUsd =
        position.sizeUsd !== null ? position.sizeUsd * (currentPrice / entryPrice - 1) : 0;
      markClosed(position.id, reason, currentPrice, null, pnlUsd);
      await notify(
        `${reason.toUpperCase()} exit ${token.symbol} (#${position.id}) — PAPER`,
        `closed at oracle price ${currentPrice.toFixed(6)} · ` +
          `P&L ${pnlUsd >= 0 ? "+" : ""}$${pnlUsd.toFixed(2)} (paper — not counted against the daily-loss limit)`,
      );
      return;
    }

    const backend = await getExecutionBackend();
    const account = await backend.accountAddress();
    const settlement = quoteAssetAddress(execToken);

    const prepared = await prepareTrade(execToken, "sell", amountIn, currentPrice, account);

    const balanceBefore =
      backend.kind === "zerodev" ? await erc20Balance(settlement, account, execToken.chain) : 0n;

    const result = await backend.sendCalls(
      prepared.calls,
      `exit(${reason}) #${position.id} ${token.symbol}`,
    );

    // Settlement confirmation: the user asked for exit notifications "confirmed
    // with receiving rhETH/USDG in wallet" — measure exactly that.
    const proceeds =
      backend.kind === "zerodev"
        ? (await erc20Balance(settlement, account, execToken.chain)) - balanceBefore
        : prepared.expectedOut;
    if (proceeds <= 0n) {
      throw new Error(`exit executed but no settlement received — investigate immediately`);
    }

    const proceedsUsd = await quoteUnitsToUsd(execToken, proceeds);
    const pnlUsd = position.sizeUsd !== null ? proceedsUsd - position.sizeUsd : 0;
    recordRealizedPnl(pnlUsd);
    markClosed(position.id, reason, prepared.executionPrice, result.txHash, pnlUsd);

    const settlementName = execToken.pairedWith ?? "USD";
    await notify(
      `${reason.toUpperCase()} exit ${token.symbol} (#${position.id})`,
      `received ${proceedsUsd.toFixed(2)} USD worth of ${settlementName} ` +
        `(${proceeds.toString()} base units confirmed in wallet) · ` +
        `P&L ${pnlUsd >= 0 ? "+" : ""}$${pnlUsd.toFixed(2)}` +
        (result.dryRun ? " · DRY RUN" : ` · tx ${result.txHash}`),
    );
  } catch (err) {
    // Never cancel an OPEN position on failure — funds are at risk until the exit
    // lands. Log loudly and retry on the next tick.
    logger.error({ err, positionId: position.id, reason }, "EXIT FAILED — will retry next tick");
    await notify(
      `EXIT FAILED ${token.symbol} (#${position.id})`,
      `${reason.toUpperCase()} exit failed: ${err instanceof Error ? err.message : String(err)} — retrying`,
    );
  }
}
