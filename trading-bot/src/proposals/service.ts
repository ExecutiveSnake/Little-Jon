import { logger } from "../logger.js";
import { DEFAULT_CHAIN, evmClient, getChainDef } from "../chain/chains.js";
import { resolveToken, type TokenInfo } from "../tokens/registry.js";
import { buildCandleSets, earliestPointT } from "../candles/store.js";
import { backfillChainlink, backfillUniv2 } from "../candles/backfill.js";
import { backfillPyth } from "../oracle/pyth.js";
import { quoteAssetFor } from "../venues/uniswapV2.js";
import { readTrustedPrice, erc20Decimals } from "../watcher/prices.js";
import { findQualifyingPlan, type AnalysisOutcome } from "../analysis/meteringClient.js";
import { createProposal, type Position } from "../positions/store.js";
import { getExecutionBackend } from "../execution/backend.js";

export interface AnalyzeResult {
  token: TokenInfo;
  currentPrice: number;
  outcome: AnalysisOutcome;
  /** Persisted proposal awaiting user confirmation, when a plan qualified. */
  proposal: Position | null;
}

/** Seeds price history once per token (the agreed "bulk pull once, then index
 *  forward" plan); subsequent calls are no-ops because history already exists. */
async function ensureHistory(token: TokenInfo): Promise<void> {
  if (earliestPointT(token.key) !== null) return;

  logger.info({ symbol: token.symbol, chain: token.chain }, "no local history — running one-time backfill");
  if (token.kind === "major") {
    await backfillPyth(token.key, token.symbol);
  } else if (token.kind === "stock") {
    if (!token.chainlinkFeed) {
      throw new Error(
        `${token.symbol} needs a Chainlink feed in config/chainlink-feeds.json before analysis`,
      );
    }
    await backfillChainlink(
      token.address,
      token.chainlinkFeed,
      undefined,
      undefined,
      token.key,
      evmClient(getChainDef(token.chain)),
    );
  } else {
    const quoteAddr = quoteAssetFor(token).address;
    await backfillUniv2(
      token.address,
      token.pairAddress!,
      token.decimals,
      await erc20Decimals(quoteAddr, token.chain),
      undefined,
      undefined,
      token.key,
      evmClient(getChainDef(token.chain)),
    );
  }
}

/**
 * The full user-triggered flow: resolve whatever the user typed → verify it's
 * tradable → make sure charts exist → read a trusted live price → run the bounded
 * Claude analysis loop → persist a proposal if (and only if) a plan cleared the
 * confidence threshold. Nothing here executes a trade — that requires the user's
 * explicit confirm with a position size.
 */
export async function analyzeToken(
  input: string,
  newsContext?: string[],
  chainId: string = DEFAULT_CHAIN,
): Promise<AnalyzeResult> {
  const token = await resolveToken(input, chainId);
  await ensureHistory(token);

  const currentPrice = await readTrustedPrice(token);
  const candles = buildCandleSets(token.key);

  const backend = await getExecutionBackend();
  const userAddress = await backend.accountAddress();

  const outcome = await findQualifyingPlan(token, currentPrice, candles, userAddress, newsContext);

  const proposal = outcome.plan ? createProposal(token, outcome.plan, currentPrice) : null;

  return { token, currentPrice, outcome, proposal };
}
