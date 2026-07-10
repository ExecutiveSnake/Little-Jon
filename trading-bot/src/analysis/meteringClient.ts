import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";

export interface AnalysisResult {
  symbol: string;
  summary: string;
  score: number;
  generatedAt: string;
}

export class InsufficientCreditsError extends Error {}
export class AnalysisUnavailableError extends Error {}

/**
 * Requests AI analysis for `symbol` from the metering service before any trade. The
 * bot must treat a failure here as "do not trade" — never fall back to trading
 * without analysis just because the metering service is unreachable.
 */
export async function requestAnalysis(
  symbol: string,
  kind: "token" | "stock-token",
): Promise<AnalysisResult> {
  const idempotencyKey = `${symbol}-${kind}-${randomUUID()}`;

  const response = await fetch(`${config.METERING_SERVICE_URL}/v1/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idempotencyKey,
      userAddress: process.env.BOT_ACCOUNT_ADDRESS,
      calls: 1,
      symbol,
      kind,
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
