import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { config } from "../config.js";

export type RequestStatus = "pending" | "delivered" | "debited" | "failed";

export interface AnalysisRequestRecord {
  idempotencyKey: string;
  userAddress: string;
  calls: number;
  status: RequestStatus;
  analysisResult: string | null;
  debitTxHash: string | null;
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
}

fs.mkdirSync(path.dirname(config.IDEMPOTENCY_DB_PATH), { recursive: true });

const db = new Database(config.IDEMPOTENCY_DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS analysis_requests (
    idempotency_key TEXT PRIMARY KEY,
    user_address    TEXT NOT NULL,
    calls           INTEGER NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'debited', 'failed')),
    analysis_result TEXT,
    debit_tx_hash   TEXT,
    failure_reason  TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS deposit_events (
    tx_hash        TEXT NOT NULL,
    log_index      INTEGER NOT NULL,
    user_address   TEXT NOT NULL,
    usde_amount    TEXT NOT NULL,
    credits_minted TEXT NOT NULL,
    block_number   INTEGER NOT NULL,
    created_at     INTEGER NOT NULL,
    PRIMARY KEY (tx_hash, log_index)
  );

  CREATE TABLE IF NOT EXISTS indexer_state (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    last_block    INTEGER NOT NULL
  );
`);

function toRecord(row: unknown): AnalysisRequestRecord {
  const r = row as {
    idempotency_key: string;
    user_address: string;
    calls: number;
    status: RequestStatus;
    analysis_result: string | null;
    debit_tx_hash: string | null;
    failure_reason: string | null;
    created_at: number;
    updated_at: number;
  };
  return {
    idempotencyKey: r.idempotency_key,
    userAddress: r.user_address,
    calls: r.calls,
    status: r.status,
    analysisResult: r.analysis_result,
    debitTxHash: r.debit_tx_hash,
    failureReason: r.failure_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getRequest(idempotencyKey: string): AnalysisRequestRecord | undefined {
  const row = db
    .prepare("SELECT * FROM analysis_requests WHERE idempotency_key = ?")
    .get(idempotencyKey);
  return row ? toRecord(row) : undefined;
}

/// Atomically create a new 'pending' request row. Returns false (no-op) if the key
/// already exists — callers must then branch on the existing record's status instead
/// of starting a fresh attempt, which is what makes retries idempotent.
export function createPendingRequest(
  idempotencyKey: string,
  userAddress: string,
  calls: number,
): boolean {
  const now = Date.now();
  try {
    db.prepare(
      `INSERT INTO analysis_requests
         (idempotency_key, user_address, calls, status, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
    ).run(idempotencyKey, userAddress, calls, now, now);
    return true;
  } catch (err) {
    if (err instanceof Database.SqliteError && err.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      return false;
    }
    throw err;
  }
}

export function markDelivered(idempotencyKey: string, analysisResult: string): void {
  db.prepare(
    `UPDATE analysis_requests
     SET status = 'delivered', analysis_result = ?, failure_reason = NULL, updated_at = ?
     WHERE idempotency_key = ?`,
  ).run(analysisResult, Date.now(), idempotencyKey);
}

export function markDebited(idempotencyKey: string, debitTxHash: string): void {
  db.prepare(
    `UPDATE analysis_requests
     SET status = 'debited', debit_tx_hash = ?, updated_at = ?
     WHERE idempotency_key = ?`,
  ).run(debitTxHash, Date.now(), idempotencyKey);
}

export function markFailed(idempotencyKey: string, reason: string): void {
  db.prepare(
    `UPDATE analysis_requests
     SET status = 'failed', failure_reason = ?, updated_at = ?
     WHERE idempotency_key = ?`,
  ).run(reason, Date.now(), idempotencyKey);
}

export function recordDepositEvent(event: {
  txHash: string;
  logIndex: number;
  userAddress: string;
  usdeAmount: bigint;
  creditsMinted: bigint;
  blockNumber: number;
}): void {
  db.prepare(
    `INSERT OR IGNORE INTO deposit_events
       (tx_hash, log_index, user_address, usde_amount, credits_minted, block_number, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.txHash,
    event.logIndex,
    event.userAddress,
    event.usdeAmount.toString(),
    event.creditsMinted.toString(),
    event.blockNumber,
    Date.now(),
  );
}

export function getLastIndexedBlock(): number | undefined {
  const row = db.prepare("SELECT last_block FROM indexer_state WHERE id = 1").get() as
    | { last_block: number }
    | undefined;
  return row?.last_block;
}

export function setLastIndexedBlock(blockNumber: number): void {
  db.prepare(
    `INSERT INTO indexer_state (id, last_block) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET last_block = excluded.last_block`,
  ).run(blockNumber);
}

export { db };
