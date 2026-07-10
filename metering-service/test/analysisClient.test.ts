import "./setupEnv.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

const { runAnalysis, validateTradePlan } = await import("../src/api/analysisClient.js");

function candle(t: number, price: number) {
  return { t, o: price, h: price * 1.01, l: price * 0.99, c: price, v: 100 };
}

const CANDLES = {
  h1: Array.from({ length: 48 }, (_, i) => candle(1_700_000_000 + i * 3600, 100 + i * 0.1)),
  h4: Array.from({ length: 30 }, (_, i) => candle(1_699_500_000 + i * 14_400, 98 + i * 0.2)),
  d1: Array.from({ length: 20 }, (_, i) => candle(1_698_000_000 + i * 86_400, 90 + i * 0.5)),
};

const PAYLOAD = {
  symbol: "NVDA",
  tokenAddress: "0x00000000000000000000000000000000000000aa",
  kind: "stock-token" as const,
  currentPrice: 105.2,
  asOf: "2026-07-10T00:00:00.000Z",
  candles: CANDLES,
};

function toolUseMessage(input: unknown) {
  return {
    model: "claude-sonnet-5",
    content: [{ type: "tool_use", id: "toolu_1", name: "submit_trade_plan", input }],
  };
}

const GOOD_PLAN = {
  hasSetup: true,
  confidence: 72,
  entryType: "trigger",
  entryPrice: 104.0,
  stopLoss: 101.5,
  takeProfit: 111.0,
  rationale: "Uptrend intact on daily; 4h consolidating above prior breakout; buy the retest.",
  keyRisks: ["macro reversal", "gap through stop"],
  timeframeNotes: { h1: "pullback", h4: "consolidation above support", d1: "uptrend" },
};

beforeEach(() => {
  mockCreate.mockReset();
});

describe("runAnalysis", () => {
  it("forces structured tool output and parses a trigger-entry trade plan", async () => {
    mockCreate.mockResolvedValue(toolUseMessage(GOOD_PLAN));

    const plan = await runAnalysis(PAYLOAD);

    expect(plan).toMatchObject({
      symbol: "NVDA",
      hasSetup: true,
      confidence: 72,
      direction: "long",
      entryType: "trigger",
      entryPrice: 104.0,
      stopLoss: 101.5,
      takeProfit: 111.0,
      model: "claude-sonnet-5",
    });

    const callArgs = mockCreate.mock.calls[0]![0] as {
      tool_choice: { type: string; name: string };
      messages: { content: string }[];
    };
    expect(callArgs.tool_choice).toEqual({ type: "tool", name: "submit_trade_plan" });
    const prompt = callArgs.messages[0]!.content;
    expect(prompt).toContain("NVDA");
    expect(prompt).toContain("105.2");
    expect(prompt).toContain("1-hour candles");
    expect(prompt).toContain("Daily candles");
    expect(prompt).toContain("SPOT ONLY");
  });

  it("normalizes a market entry: entryPrice stays null, consistency checked against current price", async () => {
    mockCreate.mockResolvedValue(
      toolUseMessage({
        ...GOOD_PLAN,
        entryType: "market",
        entryPrice: undefined,
        stopLoss: 102.0,
        takeProfit: 112.0,
      }),
    );

    const plan = await runAnalysis(PAYLOAD);

    expect(plan.entryType).toBe("market");
    expect(plan.entryPrice).toBeNull();
    expect(plan.stopLoss).toBe(102.0);
  });

  it("passes a no-setup verdict through without requiring plan fields", async () => {
    mockCreate.mockResolvedValue(
      toolUseMessage({
        hasSetup: false,
        confidence: 40,
        rationale: "Only 3 daily candles exist; insufficient history for multi-timeframe analysis.",
        keyRisks: [],
        timeframeNotes: { h1: "thin", h4: "thin", d1: "thin" },
      }),
    );

    const plan = await runAnalysis(PAYLOAD);

    expect(plan.hasSetup).toBe(false);
    expect(plan.confidence).toBe(40);
    expect(plan.entryType).toBeNull();
    expect(plan.stopLoss).toBeNull();
  });

  it("rejects an internally inconsistent plan (stop above entry)", async () => {
    mockCreate.mockResolvedValue(
      toolUseMessage({ ...GOOD_PLAN, stopLoss: 108.0 }), // stop > trigger entry of 104
    );

    await expect(runAnalysis(PAYLOAD)).rejects.toThrow(/internally inconsistent/);
  });

  it("rejects a setup missing stop/target", async () => {
    mockCreate.mockResolvedValue(
      toolUseMessage({ ...GOOD_PLAN, stopLoss: undefined, takeProfit: undefined }),
    );

    await expect(runAnalysis(PAYLOAD)).rejects.toThrow(/missing stop\/target/);
  });

  it("throws when the model responds without a tool_use block", async () => {
    mockCreate.mockResolvedValue({
      model: "claude-sonnet-5",
      content: [{ type: "text", text: "I refuse to use the tool." }],
    });

    await expect(runAnalysis(PAYLOAD)).rejects.toThrow(/did not include a submit_trade_plan/);
  });

  it("propagates errors from the Claude API call", async () => {
    mockCreate.mockRejectedValue(new Error("rate limited"));

    await expect(runAnalysis(PAYLOAD)).rejects.toThrow("rate limited");
  });

  it("includes a retry note when attempt > 1", async () => {
    mockCreate.mockResolvedValue(toolUseMessage(GOOD_PLAN));

    await runAnalysis({ ...PAYLOAD, attempt: 2 });

    const prompt = (mockCreate.mock.calls[0]![0] as { messages: { content: string }[] })
      .messages[0]!.content;
    expect(prompt).toContain("attempt 2");
    expect(prompt).toContain("do NOT lower your standards");
  });
});

describe("validateTradePlan", () => {
  it("clamps confidence into 0-100", () => {
    const plan = validateTradePlan(
      { ...GOOD_PLAN, confidence: 140 },
      { symbol: "NVDA", currentPrice: 105.2 },
      "m",
      {},
    );
    expect(plan.confidence).toBe(100);
  });

  it("rejects garbage input", () => {
    expect(() =>
      validateTradePlan(
        { hasSetup: "yes" } as never,
        { symbol: "NVDA", currentPrice: 105.2 },
        "m",
        {},
      ),
    ).toThrow(/malformed/);
  });
});
