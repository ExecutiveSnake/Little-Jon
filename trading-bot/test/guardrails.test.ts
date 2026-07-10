import "./setupEnv.js";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import {
  GuardrailViolation,
  assertDailyLossLimitNotBreached,
  assertKillSwitchNotEngaged,
  assertPositionSizeAllowed,
  assertSlippageAllowed,
  recordRealizedPnl,
} from "../src/risk/guardrails.js";

const dailyLossStatePath = path.join(path.dirname(config.KILL_SWITCH_PATH), "daily-loss-state.json");

beforeEach(() => {
  fs.rmSync(config.KILL_SWITCH_PATH, { force: true });
  fs.rmSync(dailyLossStatePath, { force: true });
});

describe("kill switch", () => {
  it("passes when the kill switch file does not exist", () => {
    expect(() => assertKillSwitchNotEngaged()).not.toThrow();
  });

  it("throws once the kill switch file is created", () => {
    fs.mkdirSync(path.dirname(config.KILL_SWITCH_PATH), { recursive: true });
    fs.writeFileSync(config.KILL_SWITCH_PATH, "");
    expect(() => assertKillSwitchNotEngaged()).toThrow(GuardrailViolation);
  });
});

describe("position size guardrail", () => {
  it("allows sizes at or under the configured max", () => {
    expect(() => assertPositionSizeAllowed(config.MAX_POSITION_SIZE_USD)).not.toThrow();
  });

  it("rejects sizes over the configured max", () => {
    expect(() => assertPositionSizeAllowed(config.MAX_POSITION_SIZE_USD + 1)).toThrow(
      GuardrailViolation,
    );
  });
});

describe("slippage guardrail", () => {
  it("allows a quoted price within the max slippage band", () => {
    const reference = 100;
    const maxDeviation = (config.MAX_SLIPPAGE_BPS / 10_000) * reference;
    expect(() => assertSlippageAllowed(reference, reference + maxDeviation * 0.9)).not.toThrow();
  });

  it("rejects a quoted price beyond the max slippage band", () => {
    const reference = 100;
    const maxDeviation = (config.MAX_SLIPPAGE_BPS / 10_000) * reference;
    expect(() => assertSlippageAllowed(reference, reference + maxDeviation * 2)).toThrow(
      GuardrailViolation,
    );
  });
});

describe("daily loss circuit breaker", () => {
  it("does not trip on realized gains", () => {
    recordRealizedPnl(1_000_000);
    expect(() => assertDailyLossLimitNotBreached()).not.toThrow();
  });

  it("trips once cumulative realized losses reach the daily limit", () => {
    recordRealizedPnl(-config.DAILY_LOSS_LIMIT_USD);
    expect(() => assertDailyLossLimitNotBreached()).toThrow(GuardrailViolation);
  });

  it("accumulates losses across multiple trades rather than resetting per trade", () => {
    const half = config.DAILY_LOSS_LIMIT_USD / 2;
    recordRealizedPnl(-half);
    expect(() => assertDailyLossLimitNotBreached()).not.toThrow();
    recordRealizedPnl(-half - 1);
    expect(() => assertDailyLossLimitNotBreached()).toThrow(GuardrailViolation);
  });

  it("does not let a later gain offset an already-tripped breaker within the same day", () => {
    recordRealizedPnl(-config.DAILY_LOSS_LIMIT_USD);
    recordRealizedPnl(1_000_000);
    expect(() => assertDailyLossLimitNotBreached()).toThrow(GuardrailViolation);
  });
});
