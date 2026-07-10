import "./setupEnv.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readTrustedPrice = vi.fn();
const executeEntry = vi.fn();
const executeExit = vi.fn();

vi.mock("../src/watcher/prices.js", () => ({
  readTrustedPrice: (...args: unknown[]) => readTrustedPrice(...args),
}));
vi.mock("../src/watcher/actions.js", () => ({
  executeEntry: (...args: unknown[]) => executeEntry(...args),
  executeExit: (...args: unknown[]) => executeExit(...args),
}));
vi.mock("../src/notify/notifier.js", () => ({ notify: vi.fn() }));

const { db } = await import("../src/db.js");
const { tick } = await import("../src/watcher/watcher.js");
const { createProposal, confirmProposal, getPosition, markOpen } = await import(
  "../src/positions/store.js"
);
const { getPricePoints } = await import("../src/candles/store.js");
const registry = await import("../src/tokens/registry.js");
import type { TokenInfo } from "../src/tokens/registry.js";
import type { TradePlan } from "../src/analysis/meteringClient.js";

const TOKEN: TokenInfo = {
  address: "0x00000000000000000000000000000000000000aa",
  symbol: "TEST",
  name: "Test",
  decimals: 18,
  kind: "lp",
  pairAddress: "0x00000000000000000000000000000000000000bb",
  pairedWith: "USDG",
  chainlinkFeed: null,
};

function seedTokenRow(): void {
  db.prepare(
    `INSERT OR REPLACE INTO tokens
       (address, symbol, name, decimals, kind, pair_address, paired_with, chainlink_feed, verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(TOKEN.address, TOKEN.symbol, TOKEN.name, 18, "lp", TOKEN.pairAddress, "USDG", null, 0);
}

function plan(overrides: Partial<TradePlan> = {}): TradePlan {
  return {
    symbol: "TEST",
    hasSetup: true,
    confidence: 70,
    direction: "long",
    entryType: "trigger",
    entryPrice: 95,
    stopLoss: 90,
    takeProfit: 120,
    rationale: "t",
    keyRisks: [],
    timeframeNotes: { h1: "", h4: "", d1: "" },
    generatedAt: "n",
    model: "m",
    ...overrides,
  };
}

// confirmProposal computes expiry from the real clock, so the tick timestamp must
// be real-clock-relative too.
const NOW = Math.floor(Date.now() / 1000);

beforeEach(() => {
  db.exec("DELETE FROM positions; DELETE FROM price_points; DELETE FROM tokens;");
  seedTokenRow();
  readTrustedPrice.mockReset();
  executeEntry.mockReset();
  executeExit.mockReset();
});

describe("watcher tick", () => {
  it("does nothing without active positions (no price reads at all)", async () => {
    await tick(NOW);
    expect(readTrustedPrice).not.toHaveBeenCalled();
  });

  it("records a price point and holds a dip entry above the trigger", async () => {
    const p = createProposal(TOKEN, plan(), 100);
    confirmProposal(p.id, 100, 3600);
    readTrustedPrice.mockResolvedValue(99);

    await tick(NOW);

    expect(executeEntry).not.toHaveBeenCalled();
    expect(getPricePoints(TOKEN.address, NOW, NOW)).toHaveLength(1);
    expect(getPosition(p.id)!.status).toBe("awaiting_entry");
  });

  it("dispatches entry when the trigger is hit", async () => {
    const p = createProposal(TOKEN, plan(), 100);
    confirmProposal(p.id, 100, 3600);
    readTrustedPrice.mockResolvedValue(94.5);

    await tick(NOW);

    expect(executeEntry).toHaveBeenCalledTimes(1);
    const [pos, tok, price] = executeEntry.mock.calls[0]!;
    expect((pos as { id: number }).id).toBe(p.id);
    expect((tok as TokenInfo).address).toBe(TOKEN.address);
    expect(price).toBe(94.5);
  });

  it("dispatches SL exit for an open position", async () => {
    const p = createProposal(TOKEN, plan(), 100);
    confirmProposal(p.id, 100, 3600);
    markOpen(p.id, 95, "1000000000000000000", null);
    readTrustedPrice.mockResolvedValue(88);

    await tick(NOW);

    expect(executeExit).toHaveBeenCalledTimes(1);
    expect(executeExit.mock.calls[0]![3]).toBe("sl");
  });

  it("dispatches TP exit for an open position", async () => {
    const p = createProposal(TOKEN, plan(), 100);
    confirmProposal(p.id, 100, 3600);
    markOpen(p.id, 95, "1000000000000000000", null);
    readTrustedPrice.mockResolvedValue(125);

    await tick(NOW);

    expect(executeExit.mock.calls[0]![3]).toBe("tp");
  });

  it("cancels an expired pending entry", async () => {
    const p = createProposal(TOKEN, plan(), 100);
    confirmProposal(p.id, 100, 1); // 1s TTL
    readTrustedPrice.mockResolvedValue(99);

    await tick(NOW + 10);

    expect(executeEntry).not.toHaveBeenCalled();
    expect(getPosition(p.id)!.status).toBe("cancelled");
  });

  it("skips a token (and fires nothing) when no trusted price is available", async () => {
    const p = createProposal(TOKEN, plan(), 100);
    confirmProposal(p.id, 100, 3600);
    markOpen(p.id, 95, "1000000000000000000", null);
    readTrustedPrice.mockRejectedValue(new Error("oracle paused"));

    await tick(NOW);

    expect(executeExit).not.toHaveBeenCalled();
    expect(getPosition(p.id)!.status).toBe("open");
  });

  it("reads each distinct token's price once per tick, not per position", async () => {
    const a = createProposal(TOKEN, plan(), 100);
    const b = createProposal(TOKEN, plan(), 100);
    confirmProposal(a.id, 100, 3600);
    confirmProposal(b.id, 100, 3600);
    readTrustedPrice.mockResolvedValue(99);

    await tick(NOW);

    expect(readTrustedPrice).toHaveBeenCalledTimes(1);
  });

  it("uses the registry row, not a stale cache", async () => {
    // guard: getKnownToken must reflect the DB written by seedTokenRow
    expect(registry.getKnownToken(TOKEN.address)?.symbol).toBe("TEST");
  });
});
