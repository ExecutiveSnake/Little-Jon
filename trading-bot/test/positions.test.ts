import "./setupEnv.js";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import {
  confirmProposal,
  createProposal,
  getPosition,
  listPositions,
  markClosed,
  markOpen,
} from "../src/positions/store.js";
import type { TradePlan } from "../src/analysis/meteringClient.js";
import type { TokenInfo } from "../src/tokens/registry.js";

const TOKEN: TokenInfo = {
  chain: "robinhood",
  key: "0x00000000000000000000000000000000000000aa",
  address: "0x00000000000000000000000000000000000000aa",
  symbol: "TEST",
  name: "Test Token",
  decimals: 18,
  kind: "lp",
  pairAddress: "0x00000000000000000000000000000000000000bb",
  pairedWith: "USDG",
  chainlinkFeed: null,
};

function plan(overrides: Partial<TradePlan> = {}): TradePlan {
  return {
    symbol: "TEST",
    hasSetup: true,
    confidence: 71,
    direction: "long",
    entryType: "trigger",
    entryPrice: 95,
    stopLoss: 90,
    takeProfit: 120,
    rationale: "test",
    keyRisks: [],
    timeframeNotes: { h1: "", h4: "", d1: "" },
    generatedAt: "now",
    model: "test",
    ...overrides,
  };
}

beforeEach(() => {
  db.exec("DELETE FROM positions");
});

describe("proposal lifecycle", () => {
  it("derives 'below' trigger direction for a dip entry", () => {
    const p = createProposal(TOKEN, plan({ entryPrice: 95 }), 100);
    expect(p.status).toBe("proposed");
    expect(p.triggerDirection).toBe("below");
  });

  it("derives 'above' trigger direction for a breakout entry", () => {
    const p = createProposal(TOKEN, plan({ entryPrice: 110, stopLoss: 100, takeProfit: 130 }), 100);
    expect(p.triggerDirection).toBe("above");
  });

  it("market entries carry no trigger direction", () => {
    const p = createProposal(TOKEN, plan({ entryType: "market", entryPrice: null }), 100);
    expect(p.triggerDirection).toBeNull();
  });

  it("refuses to store a no-setup plan", () => {
    expect(() =>
      createProposal(TOKEN, plan({ hasSetup: false, stopLoss: null, takeProfit: null }), 100),
    ).toThrow(/without a setup/);
  });

  it("confirm arms the position with size and TTL", () => {
    const p = createProposal(TOKEN, plan(), 100);
    const armed = confirmProposal(p.id, 250, 3600);
    expect(armed.status).toBe("awaiting_entry");
    expect(armed.sizeUsd).toBe(250);
    expect(armed.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("confirm refuses positions not in 'proposed'", () => {
    const p = createProposal(TOKEN, plan(), 100);
    confirmProposal(p.id, 250, 3600);
    expect(() => confirmProposal(p.id, 250, 3600)).toThrow(/not awaiting confirmation/);
  });

  it("open → closed keeps amounts as base-unit strings and records P&L", () => {
    const p = createProposal(TOKEN, plan(), 100);
    confirmProposal(p.id, 250, 3600);
    markOpen(p.id, 95.2, "123456789012345678901234567890", "0xentry");

    const open = getPosition(p.id)!;
    expect(open.status).toBe("open");
    expect(open.amountToken).toBe("123456789012345678901234567890"); // no float mangling
    expect(BigInt(open.amountToken!)).toBe(123456789012345678901234567890n);

    markClosed(p.id, "tp", 121.0, "0xexit", 62.5);
    const closed = getPosition(p.id)!;
    expect(closed.status).toBe("closed");
    expect(closed.exitReason).toBe("tp");
    expect(closed.realizedPnlUsd).toBe(62.5);
  });

  it("listPositions filters by status", () => {
    createProposal(TOKEN, plan(), 100);
    const second = createProposal(TOKEN, plan(), 100);
    confirmProposal(second.id, 100, 3600);

    expect(listPositions(["proposed"])).toHaveLength(1);
    expect(listPositions(["awaiting_entry"])).toHaveLength(1);
    expect(listPositions()).toHaveLength(2);
  });
});
