import "./setupEnv.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

const { runAnalysis } = await import("../src/api/analysisClient.js");

const PRICE_CONTEXT = {
  currentPrice: 189.42,
  asOf: "2026-07-10T00:00:00.000Z",
  recentHistory: [{ price: 185.0, timestamp: "2026-07-09T00:00:00.000Z" }],
};

function toolUseMessage(input: unknown) {
  return {
    model: "claude-sonnet-5",
    content: [{ type: "tool_use", id: "toolu_1", name: "submit_analysis", input }],
  };
}

beforeEach(() => {
  mockCreate.mockReset();
});

describe("runAnalysis", () => {
  it("forces structured tool output and parses it into an AnalysisResult", async () => {
    mockCreate.mockResolvedValue(
      toolUseMessage({
        direction: "buy",
        score: 0.72,
        summary: "Momentum looks favorable given the recent uptrend.",
        keyRisks: ["earnings volatility"],
      }),
    );

    const result = await runAnalysis({
      symbol: "AAPL",
      kind: "stock-token",
      priceContext: PRICE_CONTEXT,
      newsContext: ["Company announced record quarterly revenue."],
    });

    expect(result).toMatchObject({
      symbol: "AAPL",
      direction: "buy",
      score: 0.72,
      summary: "Momentum looks favorable given the recent uptrend.",
      keyRisks: ["earnings volatility"],
      model: "claude-sonnet-5",
    });

    const callArgs = mockCreate.mock.calls[0]![0] as {
      tool_choice: { type: string; name: string };
      messages: { content: string }[];
    };
    expect(callArgs.tool_choice).toEqual({ type: "tool", name: "submit_analysis" });
    expect(callArgs.messages[0]!.content).toContain("AAPL");
    expect(callArgs.messages[0]!.content).toContain("189.42");
    expect(callArgs.messages[0]!.content).toContain("record quarterly revenue");
  });

  it("throws when the model responds without a tool_use block", async () => {
    mockCreate.mockResolvedValue({
      model: "claude-sonnet-5",
      content: [{ type: "text", text: "I refuse to use the tool." }],
    });

    await expect(
      runAnalysis({ symbol: "AAPL", kind: "stock-token", priceContext: PRICE_CONTEXT }),
    ).rejects.toThrow(/did not include a submit_analysis tool call/);
  });

  it("throws when the tool input is malformed", async () => {
    mockCreate.mockResolvedValue(
      toolUseMessage({ direction: "definitely-buy", score: "high", summary: 123 }),
    );

    await expect(
      runAnalysis({ symbol: "AAPL", kind: "stock-token", priceContext: PRICE_CONTEXT }),
    ).rejects.toThrow(/malformed analysis/);
  });

  it("propagates errors from the Claude API call", async () => {
    mockCreate.mockRejectedValue(new Error("rate limited"));

    await expect(
      runAnalysis({ symbol: "AAPL", kind: "stock-token", priceContext: PRICE_CONTEXT }),
    ).rejects.toThrow("rate limited");
  });

  it("omits news context from the prompt when none is provided", async () => {
    mockCreate.mockResolvedValue(
      toolUseMessage({ direction: "hold", score: 0.5, summary: "Neutral.", keyRisks: [] }),
    );

    await runAnalysis({ symbol: "AAPL", kind: "stock-token", priceContext: PRICE_CONTEXT });

    const callArgs = mockCreate.mock.calls[0]![0] as { messages: { content: string }[] };
    expect(callArgs.messages[0]!.content).toContain("(none provided)");
  });
});
