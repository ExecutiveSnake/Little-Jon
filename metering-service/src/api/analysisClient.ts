import { config } from "../config.js";
import { logger } from "../logger.js";

export interface AnalysisRequestPayload {
  symbol: string;
  kind: "token" | "stock-token";
}

export interface AnalysisResult {
  symbol: string;
  summary: string;
  score: number;
  generatedAt: string;
  raw: unknown;
}

/// Calls the upstream model API for token/stock-token analysis. Throws on any
/// non-success response so callers never mistake a failed call for a delivered one —
/// that invariant is what lets the metering layer guarantee "never debit without
/// delivering."
export async function runAnalysis(payload: AnalysisRequestPayload): Promise<AnalysisResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(config.MODEL_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.MODEL_API_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "<unreadable body>");
      throw new Error(`model API returned ${response.status}: ${body}`);
    }

    const data = (await response.json()) as { summary: string; score: number };

    return {
      symbol: payload.symbol,
      summary: data.summary,
      score: data.score,
      generatedAt: new Date().toISOString(),
      raw: data,
    };
  } catch (err) {
    logger.error({ err, payload }, "model API call failed");
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
