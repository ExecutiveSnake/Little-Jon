import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { logger } from "../logger.js";

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

export interface PriceHistoryPoint {
  price: number;
  timestamp: string; // ISO 8601
}

export interface PriceContext {
  currentPrice: number;
  asOf: string; // ISO 8601, from the Chainlink read this was sourced from
  recentHistory?: PriceHistoryPoint[];
}

export interface AnalysisRequestPayload {
  symbol: string;
  kind: "token" | "stock-token";
  priceContext: PriceContext;
  /**
   * Manually curated news/context items supplied by the caller (an operator, or the
   * trading bot passing through operator-maintained notes). Deliberately NOT fetched
   * automatically from any news/social API by this service — that integration is
   * intentionally out of scope here so a low-quality or rate-limited feed (e.g.
   * Twitter/X's API) can never silently degrade analysis quality. Feed this from
   * whatever curation process you trust.
   */
  newsContext?: string[];
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
  raw: unknown;
}

const ANALYSIS_TOOL: Anthropic.Tool = {
  name: "submit_analysis",
  description:
    "Submit the structured trading analysis result for the given symbol. Always call this " +
    "exactly once with your conclusion — never respond in plain text.",
  input_schema: {
    type: "object",
    properties: {
      direction: {
        type: "string",
        enum: ["buy", "sell", "hold"],
        description: "Overall directional call.",
      },
      score: {
        type: "number",
        description:
          "Conviction score from 0 (strong sell) to 1 (strong buy); 0.5 is neutral/no-edge.",
      },
      summary: {
        type: "string",
        description: "2-4 sentence rationale for the call, referencing the price/news context given.",
      },
      keyRisks: {
        type: "array",
        items: { type: "string" },
        description: "The most important risks/uncertainties that could invalidate this call.",
      },
    },
    required: ["direction", "score", "summary", "keyRisks"],
  },
};

function buildPrompt(payload: AnalysisRequestPayload): string {
  const { symbol, kind, priceContext, newsContext } = payload;

  const historyLines =
    priceContext.recentHistory && priceContext.recentHistory.length > 0
      ? priceContext.recentHistory
          .map((p) => `  - ${p.timestamp}: $${p.price}`)
          .join("\n")
      : "  (none provided)";

  const newsLines =
    newsContext && newsContext.length > 0
      ? newsContext.map((item) => `  - ${item}`).join("\n")
      : "  (none provided)";

  return `You are a disciplined trading-analysis assistant. Analyze the following ${kind} and produce a
single structured call via the submit_analysis tool. Do not be overconfident — default to "hold"
and a score near 0.5 unless the evidence given is clear.

Symbol: ${symbol}
Kind: ${kind}

Current price: $${priceContext.currentPrice} (as of ${priceContext.asOf})
Recent price history:
${historyLines}

Manually curated news/context (may be empty):
${newsLines}

Base your analysis strictly on the information above. Do not assume access to real-time data you
were not given.`;
}

/// Calls the Claude API for token/stock-token analysis, forcing a structured tool-use
/// response so the result is always machine-parseable. Throws on any failure —
/// including a malformed/missing tool response — so callers never mistake a failed
/// call for a delivered one. That invariant is what lets the metering layer guarantee
/// "never debit without delivering."
export async function runAnalysis(payload: AnalysisRequestPayload): Promise<AnalysisResult> {
  try {
    const message = await anthropic.messages.create(
      {
        model: config.ANTHROPIC_MODEL,
        max_tokens: 1024,
        tools: [ANALYSIS_TOOL],
        tool_choice: { type: "tool", name: "submit_analysis" },
        messages: [{ role: "user", content: buildPrompt(payload) }],
      },
      { timeout: 30_000 },
    );

    const toolUse = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    if (!toolUse) {
      throw new Error("model response did not include a submit_analysis tool call");
    }

    const input = toolUse.input as {
      direction: "buy" | "sell" | "hold";
      score: number;
      summary: string;
      keyRisks: string[];
    };

    if (
      typeof input.score !== "number" ||
      typeof input.summary !== "string" ||
      !Array.isArray(input.keyRisks) ||
      !["buy", "sell", "hold"].includes(input.direction)
    ) {
      throw new Error(`model returned a malformed analysis: ${JSON.stringify(input)}`);
    }

    return {
      symbol: payload.symbol,
      direction: input.direction,
      score: input.score,
      summary: input.summary,
      keyRisks: input.keyRisks,
      generatedAt: new Date().toISOString(),
      model: message.model,
      raw: message,
    };
  } catch (err) {
    logger.error({ err, payload }, "Claude analysis call failed");
    throw err;
  }
}
