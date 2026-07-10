import type { Position } from "./store.js";

/**
 * Pure trigger evaluation — the heart of the watcher, kept free of I/O so it can
 * be tested exhaustively. Given a position and the latest trusted price, decide
 * what (if anything) must happen.
 */

export type TriggerAction =
  | { type: "enter"; reason: "market" | "trigger-hit" }
  | { type: "exit"; reason: "sl" | "tp" }
  | { type: "cancel"; reason: "expired" };

export function evaluatePosition(
  position: Position,
  price: number,
  nowSec = Math.floor(Date.now() / 1000),
): TriggerAction | null {
  if (position.status === "awaiting_entry") {
    // Expiry check first: a stale trigger must never fire late.
    if (position.expiresAt !== null && nowSec >= position.expiresAt) {
      return { type: "cancel", reason: "expired" };
    }

    if (position.entryType === "market") {
      return { type: "enter", reason: "market" };
    }

    const trigger = position.entryTriggerPrice;
    if (trigger === null || position.triggerDirection === null) return null;

    // Guard: if price has already blown through the stop (dip entry) or the target
    // (breakout entry), the setup is invalidated — cancel rather than enter a
    // position that is instantly stopped out / already at its target.
    if (price <= position.stopLoss || price >= position.takeProfit) {
      return { type: "cancel", reason: "expired" };
    }

    if (position.triggerDirection === "below" && price <= trigger) {
      return { type: "enter", reason: "trigger-hit" };
    }
    if (position.triggerDirection === "above" && price >= trigger) {
      return { type: "enter", reason: "trigger-hit" };
    }
    return null;
  }

  if (position.status === "open") {
    // Stop-loss checked before take-profit: on a reading that somehow satisfies
    // both (bad tick, huge gap), the defensive action wins.
    if (price <= position.stopLoss) {
      return { type: "exit", reason: "sl" };
    }
    if (price >= position.takeProfit) {
      return { type: "exit", reason: "tp" };
    }
    return null;
  }

  return null;
}
