import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * Little Jon's local store: token registry, price history, and position lifecycle.
 * Single SQLite file (WAL) — durable across restarts, no external service needed.
 */
if (config.DB_PATH !== ":memory:") {
  fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true });
}

export const db = new Database(config.DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    address         TEXT PRIMARY KEY,          -- storage key: robinhood = bare 0x address,
                                               -- other chains = '<chain>:<address>', majors = 'major:<SYM>'
    chain           TEXT NOT NULL DEFAULT 'robinhood',
    symbol          TEXT NOT NULL,
    name            TEXT NOT NULL,
    decimals        INTEGER NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('stock', 'lp', 'major', 'unsupported')),
    pair_address    TEXT,                      -- lp: Uniswap V2 pair used for pricing
    paired_with     TEXT,                      -- lp: quote symbol ('USDG'|'rhETH'|'USDC'|'WETH'); majors: 'USD'
    chainlink_feed  TEXT,                      -- stock: feed proxy address
    holders         INTEGER,
    verified_at     INTEGER NOT NULL,
    metadata        TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_tokens_symbol ON tokens (symbol COLLATE NOCASE);

  -- Raw price observations. Sources: 'watcher' (live polls), 'chainlink-backfill',
  -- 'univ2-backfill'. Aggregated into candles on demand, never mutated.
  CREATE TABLE IF NOT EXISTS price_points (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    token    TEXT NOT NULL,
    t        INTEGER NOT NULL,                 -- unix seconds
    price    REAL NOT NULL,
    volume   REAL NOT NULL DEFAULT 0,          -- quote-denominated where known
    source   TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_points_token_t ON price_points (token, t);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_points_dedupe ON price_points (token, t, source);

  CREATE TABLE IF NOT EXISTS positions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             TEXT NOT NULL DEFAULT 'default',
    token               TEXT NOT NULL,         -- token storage key (see tokens.address)
    chain               TEXT NOT NULL DEFAULT 'robinhood',
    symbol              TEXT NOT NULL,
    kind                TEXT NOT NULL CHECK (kind IN ('stock', 'lp', 'major')),
    status              TEXT NOT NULL CHECK (status IN
                          ('proposed', 'awaiting_entry', 'open', 'closed', 'cancelled', 'failed')),
    -- plan
    entry_type          TEXT NOT NULL CHECK (entry_type IN ('market', 'trigger')),
    entry_trigger_price REAL,
    trigger_direction   TEXT CHECK (trigger_direction IN ('above', 'below')),
    stop_loss           REAL NOT NULL,
    take_profit         REAL NOT NULL,
    confidence          REAL NOT NULL,
    plan_json           TEXT NOT NULL,
    -- sizing / fills
    size_usd            REAL,
    amount_token        TEXT,                  -- token base units (bigint as string)
    entry_price         REAL,
    entry_tx            TEXT,
    exit_reason         TEXT CHECK (exit_reason IN ('tp', 'sl', 'manual', 'expired')),
    exit_price          REAL,
    exit_tx             TEXT,
    realized_pnl_usd    REAL,
    -- bookkeeping
    expires_at          INTEGER,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_positions_status ON positions (status);
  CREATE INDEX IF NOT EXISTS idx_positions_token ON positions (token);
`);

// --- migration: single-chain (pre cross-chain) databases ---
// Older DBs lack the `chain` column and have kind CHECKs without 'major'.
// SQLite can't alter CHECK constraints, so rebuild those tables in place;
// existing rows are all Robinhood Chain by definition.
function hasColumn(table: string, column: string): boolean {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  return cols.some((c) => c.name === column);
}

if (!hasColumn("tokens", "chain")) {
  db.exec(`
    BEGIN;
    ALTER TABLE tokens RENAME TO tokens_v1;
    CREATE TABLE tokens (
      address         TEXT PRIMARY KEY,
      chain           TEXT NOT NULL DEFAULT 'robinhood',
      symbol          TEXT NOT NULL,
      name            TEXT NOT NULL,
      decimals        INTEGER NOT NULL,
      kind            TEXT NOT NULL CHECK (kind IN ('stock', 'lp', 'major', 'unsupported')),
      pair_address    TEXT,
      paired_with     TEXT,
      chainlink_feed  TEXT,
      holders         INTEGER,
      verified_at     INTEGER NOT NULL,
      metadata        TEXT
    );
    INSERT INTO tokens (address, chain, symbol, name, decimals, kind, pair_address,
                        paired_with, chainlink_feed, holders, verified_at, metadata)
      SELECT address, 'robinhood', symbol, name, decimals, kind, pair_address,
             paired_with, chainlink_feed, holders, verified_at, metadata
      FROM tokens_v1;
    DROP TABLE tokens_v1;
    CREATE INDEX IF NOT EXISTS idx_tokens_symbol ON tokens (symbol COLLATE NOCASE);
    COMMIT;
  `);
}

if (!hasColumn("positions", "chain")) {
  db.exec(`
    BEGIN;
    ALTER TABLE positions RENAME TO positions_v1;
    CREATE TABLE positions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id             TEXT NOT NULL DEFAULT 'default',
      token               TEXT NOT NULL,
      chain               TEXT NOT NULL DEFAULT 'robinhood',
      symbol              TEXT NOT NULL,
      kind                TEXT NOT NULL CHECK (kind IN ('stock', 'lp', 'major')),
      status              TEXT NOT NULL CHECK (status IN
                            ('proposed', 'awaiting_entry', 'open', 'closed', 'cancelled', 'failed')),
      entry_type          TEXT NOT NULL CHECK (entry_type IN ('market', 'trigger')),
      entry_trigger_price REAL,
      trigger_direction   TEXT CHECK (trigger_direction IN ('above', 'below')),
      stop_loss           REAL NOT NULL,
      take_profit         REAL NOT NULL,
      confidence          REAL NOT NULL,
      plan_json           TEXT NOT NULL,
      size_usd            REAL,
      amount_token        TEXT,
      entry_price         REAL,
      entry_tx            TEXT,
      exit_reason         TEXT CHECK (exit_reason IN ('tp', 'sl', 'manual', 'expired')),
      exit_price          REAL,
      exit_tx             TEXT,
      realized_pnl_usd    REAL,
      expires_at          INTEGER,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );
    INSERT INTO positions (id, user_id, token, chain, symbol, kind, status, entry_type,
                           entry_trigger_price, trigger_direction, stop_loss, take_profit,
                           confidence, plan_json, size_usd, amount_token, entry_price,
                           entry_tx, exit_reason, exit_price, exit_tx, realized_pnl_usd,
                           expires_at, created_at, updated_at)
      SELECT id, user_id, token, 'robinhood', symbol, kind, status, entry_type,
             entry_trigger_price, trigger_direction, stop_loss, take_profit,
             confidence, plan_json, size_usd, amount_token, entry_price,
             entry_tx, exit_reason, exit_price, exit_tx, realized_pnl_usd,
             expires_at, created_at, updated_at
      FROM positions_v1;
    DROP TABLE positions_v1;
    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions (status);
    CREATE INDEX IF NOT EXISTS idx_positions_token ON positions (token);
    COMMIT;
  `);
}
