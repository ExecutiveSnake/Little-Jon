import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";

export class GuardrailViolation extends Error {}

// ---------------------------------------------------------------------------
// Manual kill switch
// ---------------------------------------------------------------------------

/**
 * Manual kill switch: the presence of the file at KILL_SWITCH_PATH halts all trading.
 * A human engages it with `touch <KILL_SWITCH_PATH>` and disengages it by deleting the
 * file — deliberately a dumb, out-of-band mechanism with no on-chain dependency, so it
 * still works if the chain, bundler, or metering service are down.
 */
export function assertKillSwitchNotEngaged(): void {
  if (fs.existsSync(config.KILL_SWITCH_PATH)) {
    throw new GuardrailViolation(`kill switch engaged (${config.KILL_SWITCH_PATH} exists)`);
  }
}

// ---------------------------------------------------------------------------
// Max position size
// ---------------------------------------------------------------------------

/// Throws if a proposed position size exceeds MAX_POSITION_SIZE_USD. Call this with
/// the *notional* USD size of the trade being proposed, after sizing logic, right
/// before execution.
export function assertPositionSizeAllowed(notionalUsd: number): void {
  if (notionalUsd > config.MAX_POSITION_SIZE_USD) {
    throw new GuardrailViolation(
      `position size $${notionalUsd} exceeds max $${config.MAX_POSITION_SIZE_USD}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Max slippage
// ---------------------------------------------------------------------------

/// Throws if the actual/quoted execution price deviates from the reference oracle
/// price by more than MAX_SLIPPAGE_BPS. Call with the price actually about to be
/// executed at (e.g. from a DEX quote) vs. the Chainlink reference price.
export function assertSlippageAllowed(referencePrice: number, quotedPrice: number): void {
  const deviationBps = (Math.abs(quotedPrice - referencePrice) / referencePrice) * 10_000;
  if (deviationBps > config.MAX_SLIPPAGE_BPS) {
    throw new GuardrailViolation(
      `quoted price ${quotedPrice} deviates ${deviationBps.toFixed(1)}bps from reference ${referencePrice}, ` +
        `exceeding max ${config.MAX_SLIPPAGE_BPS}bps`,
    );
  }
}

// ---------------------------------------------------------------------------
// Daily loss circuit breaker
// ---------------------------------------------------------------------------

interface DailyLossState {
  utcDate: string; // YYYY-MM-DD
  cumulativeLossUsd: number;
}

const DAILY_LOSS_STATE_PATH = path.join(path.dirname(config.KILL_SWITCH_PATH), "daily-loss-state.json");

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function readDailyLossState(): DailyLossState {
  try {
    const raw = JSON.parse(fs.readFileSync(DAILY_LOSS_STATE_PATH, "utf8")) as DailyLossState;
    if (raw.utcDate === todayUtc()) return raw;
  } catch {
    // no state file yet, or unreadable — fall through to a fresh state
  }
  return { utcDate: todayUtc(), cumulativeLossUsd: 0 };
}

function writeDailyLossState(state: DailyLossState): void {
  fs.mkdirSync(path.dirname(DAILY_LOSS_STATE_PATH), { recursive: true });
  fs.writeFileSync(DAILY_LOSS_STATE_PATH, JSON.stringify(state));
}

/// Call once a trade's realized P&L is known. Negative `pnlUsd` accumulates toward the
/// daily loss limit; positive P&L does not "buy back" headroom within the same day —
/// the breaker is deliberately one-directional so a string of small wins can't be used
/// to justify one catastrophic loss later in the day.
export function recordRealizedPnl(pnlUsd: number): void {
  const state = readDailyLossState();
  if (pnlUsd < 0) {
    state.cumulativeLossUsd += -pnlUsd;
  }
  writeDailyLossState(state);
  logger.info({ pnlUsd, cumulativeLossUsd: state.cumulativeLossUsd }, "recorded realized P&L");
}

/// Throws if today's cumulative realized loss has already reached DAILY_LOSS_LIMIT_USD.
/// Call this before proposing any new trade, in addition to recording P&L after each one.
export function assertDailyLossLimitNotBreached(): void {
  const state = readDailyLossState();
  if (state.cumulativeLossUsd >= config.DAILY_LOSS_LIMIT_USD) {
    throw new GuardrailViolation(
      `daily loss limit breached: lost $${state.cumulativeLossUsd} of $${config.DAILY_LOSS_LIMIT_USD} today`,
    );
  }
}

// ---------------------------------------------------------------------------
// Combined pre-trade check
// ---------------------------------------------------------------------------

/// Runs every hard guardrail that can be checked before a trade is sized/priced.
/// Guardrails that depend on the specific trade (position size, slippage) are checked
/// separately once those values are known.
export function assertSafeToProposeTrade(): void {
  assertKillSwitchNotEngaged();
  assertDailyLossLimitNotBreached();
}
