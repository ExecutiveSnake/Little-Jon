import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";

export interface PriceHistoryPoint {
  price: number;
  timestamp: string; // ISO 8601
}

export interface PriceContext {
  currentPrice: number;
  asOf: string; // ISO 8601
  recentHistory?: PriceHistoryPoint[];
}

export interface AnalysisResult {
  symbol: string;
  direction: "buy" | "sell" | "hold";
  /** 0 (strong sell conviction) to 1 (strong buy conviction); 0.5 is neutral. */
  score: number;
  summary: string;
  keyRisks: string[];
  generatedAt: string;
  model: string;
}

export class InsufficientCreditsError extends Error {}
export class AnalysisUnavailableError extends Error {}

/**
 * Requests AI analysis for `symbol` from the metering service before any trade. The
 * bot must treat a failure here as "do not trade" — never fall back to trading
 * without analysis just because the metering service is unreachable.
 *
 * `newsContext` is optional, manually curated context (headlines, notes, whatever an
 * operator trusts) — this client does not fetch news/sentiment from any social API
 * itself, by design.
 */
export async function requestAnalysis(
  symbol: string,
  kind: "token" | "stock-token",
  priceContext: PriceContext,
  newsContext?: string[],
): Promise<AnalysisResult> {
  const idempotencyKey = `${symbol}-${kind}-${randomUUID()}`;

  const response = await fetch(`${config.METERING_SERVICE_URL}/v1/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idempotencyKey,
      userAddress: config.SMART_ACCOUNT_ADDRESS,
      calls: 1,
      symbol,
      kind,
      priceContext,
      newsContext,
    }),
  });

  if (response.status === 402) {
    throw new InsufficientCreditsError(`insufficient analysis credits for ${symbol}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "<unreadable>");
    logger.error({ symbol, status: response.status, body }, "metering service call failed");
    throw new AnalysisUnavailableError(`metering service returned ${response.status}`);
  }

  const data = (await response.json()) as { result: AnalysisResult };
  return data.result;
}
