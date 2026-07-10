import "./setupEnv.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getOnChainCreditBalance = vi.fn();
const debitCreditOnChain = vi.fn();
const runAnalysis = vi.fn();

vi.mock("../src/chain/contract.js", () => ({
  getOnChainCreditBalance: (...args: unknown[]) => getOnChainCreditBalance(...args),
  debitCreditOnChain: (...args: unknown[]) => debitCreditOnChain(...args),
}));

vi.mock("../src/api/analysisClient.js", () => ({
  runAnalysis: (...args: unknown[]) => runAnalysis(...args),
}));

const { processAnalysisRequest, InsufficientCreditsError } = await import(
  "../src/api/meteringService.js"
);
const { db } = await import("../src/store/idempotencyStore.js");

const USER = "0x000000000000000000000000000000000000aa";

const PRICE_CONTEXT = { currentPrice: 189.42, asOf: "2026-07-10T00:00:00.000Z" };

function payload(overrides: Partial<{ symbol: string; kind: "token" | "stock-token" }> = {}) {
  return {
    symbol: "AAPL",
    kind: "stock-token" as const,
    priceContext: PRICE_CONTEXT,
    ...overrides,
  };
}

function mockResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    symbol: "AAPL",
    direction: "buy" as const,
    score: 0.8,
    summary: "bullish",
    keyRisks: ["macro risk"],
    generatedAt: "now",
    model: "claude-sonnet-5",
    raw: {},
    ...overrides,
  };
}

beforeEach(() => {
  db.exec("DELETE FROM analysis_requests");
  getOnChainCreditBalance.mockReset();
  debitCreditOnChain.mockReset();
  runAnalysis.mockReset();
});

describe("processAnalysisRequest", () => {
  it("rejects when the user has insufficient credits, without touching the model API", async () => {
    getOnChainCreditBalance.mockResolvedValue(0n);

    await expect(
      processAnalysisRequest("key-1", USER, 1, payload()),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    expect(runAnalysis).not.toHaveBeenCalled();
    expect(debitCreditOnChain).not.toHaveBeenCalled();
  });

  it("delivers analysis and debits exactly once on the happy path", async () => {
    getOnChainCreditBalance.mockResolvedValue(10n);
    runAnalysis.mockResolvedValue(mockResult());
    debitCreditOnChain.mockResolvedValue("0xdeadbeef");

    const result = await processAnalysisRequest("key-2", USER, 1, payload());

    expect(result.summary).toBe("bullish");
    expect(result.direction).toBe("buy");
    expect(runAnalysis).toHaveBeenCalledTimes(1);
    expect(debitCreditOnChain).toHaveBeenCalledTimes(1);
    expect(debitCreditOnChain).toHaveBeenCalledWith(USER, 1n);
  });

  it("never debits when the model API call fails", async () => {
    getOnChainCreditBalance.mockResolvedValue(10n);
    runAnalysis.mockRejectedValue(new Error("model API down"));

    await expect(
      processAnalysisRequest("key-3", USER, 1, payload()),
    ).rejects.toThrow("model API down");

    expect(debitCreditOnChain).not.toHaveBeenCalled();
  });

  it("retrying after a failed model call re-attempts analysis (does not reuse a stale failure)", async () => {
    getOnChainCreditBalance.mockResolvedValue(10n);
    runAnalysis.mockRejectedValueOnce(new Error("transient failure"));
    runAnalysis.mockResolvedValueOnce(mockResult());
    debitCreditOnChain.mockResolvedValue("0xdeadbeef");

    await expect(
      processAnalysisRequest("key-4", USER, 1, payload()),
    ).rejects.toThrow("transient failure");
    expect(debitCreditOnChain).not.toHaveBeenCalled();

    const result = await processAnalysisRequest("key-4", USER, 1, payload());

    expect(result.summary).toBe("bullish");
    expect(runAnalysis).toHaveBeenCalledTimes(2);
    expect(debitCreditOnChain).toHaveBeenCalledTimes(1);
  });

  it("retrying after analysis was delivered but the debit failed does not re-call the model API", async () => {
    getOnChainCreditBalance.mockResolvedValue(10n);
    runAnalysis.mockResolvedValue(mockResult());
    debitCreditOnChain.mockRejectedValueOnce(new Error("rpc timeout"));
    debitCreditOnChain.mockResolvedValueOnce("0xdeadbeef");

    await expect(
      processAnalysisRequest("key-5", USER, 1, payload()),
    ).rejects.toThrow("rpc timeout");

    const result = await processAnalysisRequest("key-5", USER, 1, payload());

    expect(result.summary).toBe("bullish");
    // Model API was only ever called once, even though the first debit attempt failed.
    expect(runAnalysis).toHaveBeenCalledTimes(1);
    expect(debitCreditOnChain).toHaveBeenCalledTimes(2);
  });

  it("a fully completed (debited) request replays its cached result without re-debiting", async () => {
    getOnChainCreditBalance.mockResolvedValue(10n);
    runAnalysis.mockResolvedValue(mockResult());
    debitCreditOnChain.mockResolvedValue("0xdeadbeef");

    await processAnalysisRequest("key-6", USER, 1, payload());
    const replay = await processAnalysisRequest("key-6", USER, 1, payload());

    expect(replay.summary).toBe("bullish");
    expect(runAnalysis).toHaveBeenCalledTimes(1);
    expect(debitCreditOnChain).toHaveBeenCalledTimes(1);
  });

  it("rejects reuse of an idempotency key with different parameters", async () => {
    getOnChainCreditBalance.mockResolvedValue(10n);
    runAnalysis.mockResolvedValue(mockResult());
    debitCreditOnChain.mockResolvedValue("0xdeadbeef");

    await processAnalysisRequest("key-7", USER, 1, payload());

    await expect(
      processAnalysisRequest("key-7", USER, 2, payload()),
    ).rejects.toThrow(/different parameters/);
  });
});
