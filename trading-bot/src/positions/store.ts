import { db } from "../db.js";
import type { TradePlan } from "../analysis/meteringClient.js";
import type { LjChainId } from "../chain/chains.js";
import type { TokenInfo } from "../tokens/registry.js";

export type PositionStatus =
  | "proposed"
  | "awaiting_entry"
  | "open"
  | "closed"
  | "cancelled"
  | "failed";

export type ExitReason = "tp" | "sl" | "manual" | "expired";

export interface Position {
  id: number;
  userId: string;
  /** Token storage key (registry.tokenStorageKey / majors.majorKey). */
  token: string;
  chain: LjChainId;
  symbol: string;
  kind: "stock" | "lp" | "major";
  status: PositionStatus;
  entryType: "market" | "trigger";
  entryTriggerPrice: number | null;
  /** For trigger entries: whether we enter when price crosses above or below the trigger. */
  triggerDirection: "above" | "below" | null;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  sizeUsd: number | null;
  /** Token base units held, as a bigint string. */
  amountToken: string | null;
  entryPrice: number | null;
  entryTx: string | null;
  exitReason: ExitReason | null;
  exitPrice: number | null;
  exitTx: string | null;
  realizedPnlUsd: number | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  plan: TradePlan;
}

function rowToPosition(row: Record<string, unknown>): Position {
  return {
    id: row.id as number,
    userId: row.user_id as string,
    token: row.token as string,
    chain: ((row.chain as string) ?? "robinhood") as LjChainId,
    symbol: row.symbol as string,
    kind: row.kind as "stock" | "lp" | "major",
    status: row.status as PositionStatus,
    entryType: row.entry_type as "market" | "trigger",
    entryTriggerPrice: row.entry_trigger_price as number | null,
    triggerDirection: row.trigger_direction as "above" | "below" | null,
    stopLoss: row.stop_loss as number,
    takeProfit: row.take_profit as number,
    confidence: row.confidence as number,
    sizeUsd: row.size_usd as number | null,
    amountToken: row.amount_token as string | null,
    entryPrice: row.entry_price as number | null,
    entryTx: row.entry_tx as string | null,
    exitReason: row.exit_reason as ExitReason | null,
    exitPrice: row.exit_price as number | null,
    exitTx: row.exit_tx as string | null,
    realizedPnlUsd: row.realized_pnl_usd as number | null,
    expiresAt: row.expires_at as number | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    plan: JSON.parse(row.plan_json as string) as TradePlan,
  };
}

/**
 * Records a qualifying plan as a proposal awaiting the user's manual confirmation
 * and position size. `triggerDirection` is derived here, at proposal time, from
 * where the trigger sits relative to the current price: below → buy-the-dip
 * (enter when price falls to the trigger), above → breakout (enter when price
 * rises through it).
 */
export function createProposal(
  token: TokenInfo,
  plan: TradePlan,
  currentPrice: number,
  userId = "default",
): Position {
  if (!plan.hasSetup || plan.stopLoss === null || plan.takeProfit === null) {
    throw new Error("cannot create a proposal from a plan without a setup");
  }
  const now = Math.floor(Date.now() / 1000);
  const triggerDirection =
    plan.entryType === "trigger" && plan.entryPrice !== null
      ? plan.entryPrice <= currentPrice
        ? ("below" as const)
        : ("above" as const)
      : null;

  const result = db
    .prepare(
      `INSERT INTO positions
         (user_id, token, chain, symbol, kind, status, entry_type, entry_trigger_price,
          trigger_direction, stop_loss, take_profit, confidence, plan_json,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      userId,
      token.key,
      token.chain,
      token.symbol,
      token.kind,
      plan.entryType,
      plan.entryPrice,
      triggerDirection,
      plan.stopLoss,
      plan.takeProfit,
      plan.confidence,
      JSON.stringify(plan),
      now,
      now,
    );

  return getPosition(Number(result.lastInsertRowid))!;
}

export function getPosition(id: number): Position | undefined {
  const row = db.prepare(`SELECT * FROM positions WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToPosition(row) : undefined;
}

export function listPositions(statuses?: PositionStatus[]): Position[] {
  const rows = (
    statuses && statuses.length > 0
      ? db
          .prepare(
            `SELECT * FROM positions WHERE status IN (${statuses.map(() => "?").join(",")})
             ORDER BY id DESC`,
          )
          .all(...statuses)
      : db.prepare(`SELECT * FROM positions ORDER BY id DESC`).all()
  ) as Record<string, unknown>[];
  return rows.map(rowToPosition);
}

function update(id: number, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields);
  const assignments = keys.map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE positions SET ${assignments}, updated_at = ? WHERE id = ?`).run(
    ...keys.map((k) => fields[k]),
    Math.floor(Date.now() / 1000),
    id,
  );
}

/** User confirmed the proposal with a size: it becomes live for the watcher. */
export function confirmProposal(id: number, sizeUsd: number, entryTtlSec: number): Position {
  const position = getPosition(id);
  if (!position) throw new Error(`position ${id} not found`);
  if (position.status !== "proposed") {
    throw new Error(`position ${id} is ${position.status}, not awaiting confirmation`);
  }
  update(id, {
    status: "awaiting_entry",
    size_usd: sizeUsd,
    expires_at: Math.floor(Date.now() / 1000) + entryTtlSec,
  });
  return getPosition(id)!;
}

export function markOpen(
  id: number,
  entryPrice: number,
  amountTokenBaseUnits: string,
  entryTx: string | null,
): void {
  update(id, {
    status: "open",
    entry_price: entryPrice,
    amount_token: amountTokenBaseUnits,
    entry_tx: entryTx,
    expires_at: null,
  });
}

export function markClosed(
  id: number,
  reason: ExitReason,
  exitPrice: number,
  exitTx: string | null,
  realizedPnlUsd: number,
): void {
  update(id, {
    status: "closed",
    exit_reason: reason,
    exit_price: exitPrice,
    exit_tx: exitTx,
    realized_pnl_usd: realizedPnlUsd,
  });
}

export function markCancelled(id: number, reason: ExitReason = "manual"): void {
  update(id, { status: "cancelled", exit_reason: reason });
}

export function markFailed(id: number): void {
  update(id, { status: "failed" });
}
