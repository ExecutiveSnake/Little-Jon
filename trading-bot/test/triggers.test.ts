import "./setupEnv.js";
import { describe, expect, it } from "vitest";
import { evaluatePosition } from "../src/positions/triggers.js";
import type { Position } from "../src/positions/store.js";

const NOW = 1_800_000_000;

function position(overrides: Partial<Position>): Position {
  return {
    id: 1,
    userId: "default",
    token: "0xtoken",
    symbol: "TEST",
    kind: "lp",
    status: "open",
    entryType: "market",
    entryTriggerPrice: null,
    triggerDirection: null,
    stopLoss: 90,
    takeProfit: 120,
    confidence: 70,
    sizeUsd: 100,
    amountToken: "1000000000000000000",
    entryPrice: 100,
    entryTx: null,
    exitReason: null,
    exitPrice: null,
    exitTx: null,
    realizedPnlUsd: null,
    expiresAt: null,
    createdAt: NOW - 3600,
    updatedAt: NOW - 3600,
    plan: {} as Position["plan"],
    ...overrides,
  };
}

describe("open positions (SL/TP)", () => {
  it("does nothing while price is between stop and target", () => {
    expect(evaluatePosition(position({}), 100, NOW)).toBeNull();
    expect(evaluatePosition(position({}), 90.01, NOW)).toBeNull();
    expect(evaluatePosition(position({}), 119.99, NOW)).toBeNull();
  });

  it("exits at stop-loss when price touches or crosses it", () => {
    expect(evaluatePosition(position({}), 90, NOW)).toEqual({ type: "exit", reason: "sl" });
    expect(evaluatePosition(position({}), 70, NOW)).toEqual({ type: "exit", reason: "sl" });
  });

  it("exits at take-profit when price touches or crosses it", () => {
    expect(evaluatePosition(position({}), 120, NOW)).toEqual({ type: "exit", reason: "tp" });
    expect(evaluatePosition(position({}), 150, NOW)).toEqual({ type: "exit", reason: "tp" });
  });

  it("prefers the stop-loss on a pathological reading satisfying both", () => {
    const p = position({ stopLoss: 100, takeProfit: 100 });
    expect(evaluatePosition(p, 100, NOW)).toEqual({ type: "exit", reason: "sl" });
  });
});

describe("awaiting_entry — market", () => {
  it("enters immediately", () => {
    const p = position({ status: "awaiting_entry", entryType: "market" });
    expect(evaluatePosition(p, 100, NOW)).toEqual({ type: "enter", reason: "market" });
  });
});

describe("awaiting_entry — trigger", () => {
  const dip = position({
    status: "awaiting_entry",
    entryType: "trigger",
    entryTriggerPrice: 95,
    triggerDirection: "below",
    expiresAt: NOW + 3600,
  });

  it("dip entry waits above the trigger and fires at/below it", () => {
    expect(evaluatePosition(dip, 97, NOW)).toBeNull();
    expect(evaluatePosition(dip, 95, NOW)).toEqual({ type: "enter", reason: "trigger-hit" });
    expect(evaluatePosition(dip, 94, NOW)).toEqual({ type: "enter", reason: "trigger-hit" });
  });

  it("breakout entry waits below the trigger and fires at/above it", () => {
    const breakout = position({
      status: "awaiting_entry",
      entryType: "trigger",
      entryTriggerPrice: 110,
      triggerDirection: "above",
      expiresAt: NOW + 3600,
    });
    expect(evaluatePosition(breakout, 105, NOW)).toBeNull();
    expect(evaluatePosition(breakout, 110, NOW)).toEqual({ type: "enter", reason: "trigger-hit" });
  });

  it("cancels instead of entering when price has already broken the stop", () => {
    // Gap through the trigger straight past the stop: entering would be instantly
    // stopped out.
    expect(evaluatePosition(dip, 89, NOW)).toEqual({ type: "cancel", reason: "expired" });
  });

  it("cancels instead of entering when price is already beyond the target", () => {
    const breakout = position({
      status: "awaiting_entry",
      entryType: "trigger",
      entryTriggerPrice: 110,
      triggerDirection: "above",
      expiresAt: NOW + 3600,
    });
    expect(evaluatePosition(breakout, 121, NOW)).toEqual({ type: "cancel", reason: "expired" });
  });

  it("expires a trigger that outlived its TTL, even if it would otherwise fire", () => {
    const stale = position({
      status: "awaiting_entry",
      entryType: "trigger",
      entryTriggerPrice: 95,
      triggerDirection: "below",
      expiresAt: NOW - 1,
    });
    expect(evaluatePosition(stale, 94, NOW)).toEqual({ type: "cancel", reason: "expired" });
  });
});

describe("terminal states", () => {
  it("never acts on proposed/closed/cancelled/failed positions", () => {
    for (const status of ["proposed", "closed", "cancelled", "failed"] as const) {
      expect(evaluatePosition(position({ status }), 50, NOW)).toBeNull();
    }
  });
});
