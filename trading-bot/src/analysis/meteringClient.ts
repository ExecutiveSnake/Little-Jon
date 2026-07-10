import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { CandleSets } from "../candles/store.js";
import type { TokenInfo } from "../tokens/registry.js";

/** Structured spot trade plan returned by the metering service's Claude agent. */
export interface TradePlan {
  symbol: string;
  hasSetup: boolean;
  confidence: number; // 0-100
  direction: "long" | null;
  entryType: "market" | "trigger" | null;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  rationale: string;
  keyRisks: string[];
  timeframeNotes: { h1: string; h4: string; d1: string };
  generatedAt: string;
  model: string;
}

export class InsufficientCreditsError extends Error {}
export class AnalysisUnavailableError extends Error {}

async function requestSinglePlan(
  token: TokenInfo,
  currentPrice: number,
  candles: CandleSets,
  attempt: number,
  userAddress: string,
  newsContext?: string[],
): Promise<TradePlan> {
  const idempotencyKey = `${token.address}-${attempt}-${randomUUID()}`;

  const response = await fetch(`${config.METERING_SERVICE_URL}/v1/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idempotencyKey,
      userAddress,
      calls: 1,
      symbol: token.symbol,
      tokenAddress: token.address,
      kind: token.kind === "stock" ? "stock-token" : token.kind === "major" ? "major" : "lp-token",
      currentPrice,
      asOf: new Date().toISOString(),
      candles,
      attempt,
      newsContext,
    }),
  });

  if (response.status === 402) {
    throw new InsufficientCreditsError(`insufficient analysis credits for ${token.symbol}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "<unreadable>");
    logger.error({ symbol: token.symbol, status: response.status, body }, "metering call failed");
    throw new AnalysisUnavailableError(`metering service returned ${response.status}`);
  }

  const data = (await response.json()) as { result: TradePlan };
  return data.result;
}

export interface AnalysisOutcome {
  /** The qualifying plan, or null if no attempt cleared the threshold. */
  plan: TradePlan | null;
  /** Every plan returned across attempts (for display: "best rejected was 58%"). */
  attempts: TradePlan[];
  threshold: number;
}

/**
 * Runs the analysis loop the user specified: ask Claude for a setup; if the result
 * is below the confidence threshold (min 65), re-analyze from a different angle —
 * bounded by MAX_ANALYSIS_ATTEMPTS because every pass burns a paid credit. Never
 * lowers the bar; if nothing qualifies, the caller reports that honestly instead
 * of trading a weak setup.
 */
export async function findQualifyingPlan(
  token: TokenInfo,
  currentPrice: number,
  candles: CandleSets,
  userAddress: string,
  newsContext?: string[],
): Promise<AnalysisOutcome> {
  const threshold = config.CONFIDENCE_THRESHOLD;
  const attempts: TradePlan[] = [];

  for (let attempt = 1; attempt <= config.MAX_ANALYSIS_ATTEMPTS; attempt++) {
    const plan = await requestSinglePlan(
      token,
      currentPrice,
      candles,
      attempt,
      userAddress,
      newsContext,
    );
    attempts.push(plan);

    if (plan.hasSetup && plan.confidence >= threshold) {
      logger.info(
        { symbol: token.symbol, confidence: plan.confidence, attempt },
        "qualifying trade plan found",
      );
      return { plan, attempts, threshold };
    }

    logger.info(
      { symbol: token.symbol, attempt, hasSetup: plan.hasSetup, confidence: plan.confidence },
      "plan below threshold; retrying with fresh eyes",
    );
  }

  return { plan: null, attempts, threshold };
}
