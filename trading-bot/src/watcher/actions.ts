import type { Address } from "viem";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { TokenInfo } from "../tokens/registry.js";
import { buildLpSwap } from "../venues/uniswapV2.js";
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
  return (token.pairedWith === "rhETH" ? config.RHETH_ADDRESS : config.USDG_ADDRESS) as Address;
}

/** Converts the user's USD size into quote-asset base units. */
export async function sizeToQuoteUnits(token: TokenInfo, sizeUsd: number): Promise<bigint> {
  const quote = quoteAssetAddress(token);
  const decimals = await erc20Decimals(quote);
  if (token.kind === "lp" && token.pairedWith === "rhETH") {
    const ethUsd = await getEthUsdPrice();
    return BigInt(Math.floor((sizeUsd / ethUsd) * 10 ** decimals));
  }
  return BigInt(Math.floor(sizeUsd * 10 ** decimals)); // USDG ≈ USD
}

/** Converts quote-asset base units to USD for P&L accounting. */
export async function quoteUnitsToUsd(token: TokenInfo, amount: bigint): Promise<number> {
  const quote = quoteAssetAddress(token);
  const decimals = await erc20Decimals(quote);
  const human = Number(amount) / 10 ** decimals;
  if (token.kind === "lp" && token.pairedWith === "rhETH") {
    return human * (await getEthUsdPrice());
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

    const backend = await getExecutionBackend();
    const account = await backend.accountAddress();
    const amountIn = await sizeToQuoteUnits(token, position.sizeUsd);

    const prepared = await prepareTrade(token, "buy", amountIn, currentPrice, account);

    const balanceBefore =
      backend.kind === "zerodev" ? await erc20Balance(token.address, account) : 0n;

    const result = await backend.sendCalls(prepared.calls, `entry #${position.id} ${token.symbol}`);

    const received =
      backend.kind === "zerodev"
        ? (await erc20Balance(token.address, account)) - balanceBefore
        : prepared.expectedOut;
    if (received <= 0n) {
      throw new Error(`entry executed but no ${token.symbol} received — investigate immediately`);
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

    const backend = await getExecutionBackend();
    const account = await backend.accountAddress();
    const settlement = quoteAssetAddress(token);

    const prepared = await prepareTrade(token, "sell", amountIn, currentPrice, account);

    const balanceBefore =
      backend.kind === "zerodev" ? await erc20Balance(settlement, account) : 0n;

    const result = await backend.sendCalls(
      prepared.calls,
      `exit(${reason}) #${position.id} ${token.symbol}`,
    );

    // Settlement confirmation: the user asked for exit notifications "confirmed
    // with receiving rhETH/USDG in wallet" — measure exactly that.
    const proceeds =
      backend.kind === "zerodev"
        ? (await erc20Balance(settlement, account)) - balanceBefore
        : prepared.expectedOut;
    if (proceeds <= 0n) {
      throw new Error(`exit executed but no settlement received — investigate immediately`);
    }

    const proceedsUsd = await quoteUnitsToUsd(token, proceeds);
    const pnlUsd = position.sizeUsd !== null ? proceedsUsd - position.sizeUsd : 0;
    recordRealizedPnl(pnlUsd);
    markClosed(position.id, reason, prepared.executionPrice, result.txHash, pnlUsd);

    const settlementName = token.pairedWith === "rhETH" ? "rhETH" : "USDG";
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
