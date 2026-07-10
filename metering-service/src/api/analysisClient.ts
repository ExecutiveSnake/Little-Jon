import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { logger } from "../logger.js";

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

/** One OHLCV candle. `t` is the bucket-open unix timestamp in seconds. */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Volume in quote terms where known; 0 when the source can't provide it (e.g. Chainlink rounds). */
  v: number;
}

/** Multi-timeframe candle sets. Most recent candle last. Arrays may be short or empty for young tokens. */
export interface CandleSets {
  h1: Candle[];
  h4: Candle[];
  d1: Candle[];
}

export type TokenKind = "stock-token" | "lp-token" | "major";

export interface AnalysisRequestPayload {
  symbol: string;
  tokenAddress: string;
  kind: TokenKind;
  currentPrice: number;
  /** ISO 8601 timestamp of the price reading. */
  asOf: string;
  candles: CandleSets;
  /**
   * Retry attempt number (1-based). On retries the prompt asks the model to
   * re-examine from a different angle rather than repeat itself.
   */
  attempt?: number;
  /**
   * Manually curated news/context items supplied by the caller (an operator, or the
   * trading bot passing through operator-maintained notes). Deliberately NOT fetched
   * automatically from any news/social API by this service — that integration is
   * intentionally out of scope here so a low-quality or rate-limited feed (e.g.
   * Twitter/X's API) can never silently degrade analysis quality.
   */
  newsContext?: string[];
}

/**
 * A structured spot trade plan. Spot-only: entries are always buys (long); there is
 * no leverage or shorting on Robinhood Chain stock tokens or LP'd tokens.
 */
export interface TradePlan {
  symbol: string;
  /** Whether the model found a setup at all. When false, everything below except confidence/rationale is null. */
  hasSetup: boolean;
  /** 0-100 conviction. The bot's threshold gate (min 65) is applied by the caller, not here. */
  confidence: number;
  direction: "long" | null;
  /** "market" = enter immediately at current price; "trigger" = enter when price reaches entryPrice. */
  entryType: "market" | "trigger" | null;
  /** Trigger price for entry. Null for market entries. */
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  rationale: string;
  keyRisks: string[];
  timeframeNotes: { h1: string; h4: string; d1: string };
  generatedAt: string;
  model: string;
  raw: unknown;
}

const TRADE_PLAN_TOOL: Anthropic.Tool = {
  name: "submit_trade_plan",
  description:
    "Submit your structured trade-plan conclusion for the given token. Always call this exactly " +
    "once — never respond in plain text. If no setup meets the quality bar, submit hasSetup=false " +
    "with your reasoning rather than forcing a marginal setup.",
  input_schema: {
    type: "object",
    properties: {
      hasSetup: {
        type: "boolean",
        description:
          "True only if you found a concrete spot-long setup worth proposing. False if the data is " +
          "insufficient, the chart is unclear, or no setup meets the quality bar.",
      },
      confidence: {
        type: "number",
        description:
          "Conviction 0-100 that this setup plays out as planned. Be calibrated: 65+ means genuine " +
          "multi-timeframe confluence, not hope. When hasSetup=false, report the confidence of your " +
          "best rejected candidate (or 0 if none).",
      },
      entryType: {
        type: "string",
        enum: ["market", "trigger"],
        description:
          "market = enter now at the current price. trigger = enter only when price reaches entryPrice " +
          "(e.g. a pullback to support or a breakout confirmation). Omit when hasSetup=false.",
      },
      entryPrice: {
        type: "number",
        description:
          "The trigger price for entry when entryType=trigger. Omit for market entries and when hasSetup=false.",
      },
      stopLoss: {
        type: "number",
        description:
          "Stop-loss price. Must be below the entry price (spot long). Place it at a level that " +
          "invalidates the setup, not an arbitrary percentage. Omit when hasSetup=false.",
      },
      takeProfit: {
        type: "number",
        description:
          "Take-profit price. Must be above the entry price (spot long). Omit when hasSetup=false.",
      },
      rationale: {
        type: "string",
        description:
          "3-6 sentence explanation of the setup (or of why there is no setup), referencing specific " +
          "structure in the provided candles.",
      },
      keyRisks: {
        type: "array",
        items: { type: "string" },
        description: "The most important risks/uncertainties that could invalidate this plan.",
      },
      timeframeNotes: {
        type: "object",
        properties: {
          h1: { type: "string", description: "One-line read of the 1h chart." },
          h4: { type: "string", description: "One-line read of the 4h chart." },
          d1: { type: "string", description: "One-line read of the daily chart." },
        },
        required: ["h1", "h4", "d1"],
        description: "Your read of each timeframe, one line each.",
      },
    },
    required: ["hasSetup", "confidence", "rationale", "keyRisks", "timeframeNotes"],
  },
};

function formatCandles(name: string, candles: Candle[]): string {
  if (candles.length === 0) return `${name}: (no data)`;
  const lines = candles.map(
    (c) =>
      `${new Date(c.t * 1000).toISOString()} o=${c.o} h=${c.h} l=${c.l} c=${c.c}${c.v > 0 ? ` v=${c.v}` : ""}`,
  );
  return `${name} (${candles.length} candles, oldest first):\n${lines.join("\n")}`;
}

function buildPrompt(payload: AnalysisRequestPayload): string {
  const { symbol, kind, currentPrice, asOf, candles, newsContext, attempt } = payload;

  const newsLines =
    newsContext && newsContext.length > 0
      ? newsContext.map((item) => `  - ${item}`).join("\n")
      : "  (none provided)";

  const retryNote =
    attempt && attempt > 1
      ? `\nThis is attempt ${attempt}. A previous pass did not find a setup meeting the bar. Re-examine ` +
        `the data from a different angle (different structure, different timeframe emphasis), but do NOT ` +
        `lower your standards — if there is still no qualifying setup, say so.`
      : "";

  return `You are a disciplined technical analyst for spot trading on Robinhood Chain. Study the
multi-timeframe data below and produce exactly one submit_trade_plan tool call.

Hard rules:
- SPOT ONLY. Long entries only (buy, then exit via stop-loss or take-profit). No shorts, no leverage.
- Base your analysis STRICTLY on the data provided. You have no other market access.
- If the candle history is too short or too sparse for real multi-timeframe analysis, that is a
  hard reason to submit hasSetup=false — never invent structure from a handful of candles.
- Be calibrated. A confidence of 65+ must mean genuine confluence across timeframes (trend
  alignment, a defined level to trade against, and a coherent invalidation). Most charts most of
  the time do NOT contain a 65+ setup, and saying so is the correct answer.
- Stops go where the setup is invalidated; targets at realistic structure. A plan whose stop or
  target makes no sense relative to the visible range is worse than no plan.
- stopLoss < entry price < takeProfit must hold (entry price = current price for market entries).

Token: ${symbol} (${kind}) at ${payload.tokenAddress}
Current price: $${currentPrice} (as of ${asOf})

${formatCandles("1-hour candles", candles.h1)}

${formatCandles("4-hour candles", candles.h4)}

${formatCandles("Daily candles", candles.d1)}

Manually curated news/context (may be empty):
${newsLines}
${retryNote}`;
}

interface RawPlanInput {
  hasSetup: boolean;
  confidence: number;
  entryType?: "market" | "trigger";
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  rationale: string;
  keyRisks: string[];
  timeframeNotes: { h1: string; h4: string; d1: string };
}

/**
 * Validates the model's tool input and normalizes it into a TradePlan. Throws on
 * anything malformed or internally inconsistent (e.g. a "long" whose stop is above
 * entry) so a bad plan can never silently reach the execution layer.
 */
export function validateTradePlan(
  input: RawPlanInput,
  payload: Pick<AnalysisRequestPayload, "symbol" | "currentPrice">,
  model: string,
  raw: unknown,
): TradePlan {
  if (
    typeof input.hasSetup !== "boolean" ||
    typeof input.confidence !== "number" ||
    typeof input.rationale !== "string" ||
    !Array.isArray(input.keyRisks) ||
    typeof input.timeframeNotes !== "object" ||
    input.timeframeNotes === null
  ) {
    throw new Error(`model returned a malformed trade plan: ${JSON.stringify(input)}`);
  }

  const confidence = Math.max(0, Math.min(100, input.confidence));

  if (!input.hasSetup) {
    return {
      symbol: payload.symbol,
      hasSetup: false,
      confidence,
      direction: null,
      entryType: null,
      entryPrice: null,
      stopLoss: null,
      takeProfit: null,
      rationale: input.rationale,
      keyRisks: input.keyRisks,
      timeframeNotes: input.timeframeNotes,
      generatedAt: new Date().toISOString(),
      model,
      raw,
    };
  }

  const entryType = input.entryType;
  if (entryType !== "market" && entryType !== "trigger") {
    throw new Error(`trade plan has setup but invalid entryType: ${JSON.stringify(input)}`);
  }

  const effectiveEntry = entryType === "market" ? payload.currentPrice : input.entryPrice;
  if (typeof effectiveEntry !== "number" || effectiveEntry <= 0) {
    throw new Error(`trade plan has setup but no usable entry price: ${JSON.stringify(input)}`);
  }
  if (typeof input.stopLoss !== "number" || typeof input.takeProfit !== "number") {
    throw new Error(`trade plan has setup but missing stop/target: ${JSON.stringify(input)}`);
  }
  if (!(input.stopLoss < effectiveEntry && effectiveEntry < input.takeProfit)) {
    throw new Error(
      `trade plan is internally inconsistent (need stopLoss < entry < takeProfit): ` +
        `stop=${input.stopLoss} entry=${effectiveEntry} target=${input.takeProfit}`,
    );
  }

  return {
    symbol: payload.symbol,
    hasSetup: true,
    confidence,
    direction: "long",
    entryType,
    entryPrice: entryType === "trigger" ? (input.entryPrice as number) : null,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    rationale: input.rationale,
    keyRisks: input.keyRisks,
    timeframeNotes: input.timeframeNotes,
    generatedAt: new Date().toISOString(),
    model,
    raw,
  };
}

/// Calls the Claude API for a multi-timeframe trade plan, forcing a structured
/// tool-use response so the result is always machine-parseable. Throws on any failure
/// — including a malformed/missing/inconsistent tool response — so callers never
/// mistake a failed call for a delivered one. That invariant is what lets the
/// metering layer guarantee "never debit without delivering."
export async function runAnalysis(payload: AnalysisRequestPayload): Promise<TradePlan> {
  try {
    const message = await anthropic.messages.create(
      {
        model: config.ANTHROPIC_MODEL,
        max_tokens: 2048,
        tools: [TRADE_PLAN_TOOL],
        tool_choice: { type: "tool", name: "submit_trade_plan" },
        messages: [{ role: "user", content: buildPrompt(payload) }],
      },
      { timeout: 60_000 },
    );

    const toolUse = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    if (!toolUse) {
      throw new Error("model response did not include a submit_trade_plan tool call");
    }

    return validateTradePlan(toolUse.input as RawPlanInput, payload, message.model, message);
  } catch (err) {
    logger.error({ err, symbol: payload.symbol, kind: payload.kind }, "Claude analysis call failed");
    throw err;
  }
}
