import fs from "node:fs";
import type { Address } from "viem";
import { db } from "../db.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { publicClient } from "../chain/clients.js";
import { ERC20_ABI, ERC8056_ABI, UNIV2_FACTORY_ABI, UNIV2_PAIR_ABI } from "../chain/abis.js";
import { rankCandidates, searchTokens } from "./blockscout.js";

export type TokenKind = "stock" | "lp";

export interface TokenInfo {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  kind: TokenKind;
  /** LP tokens: the Uniswap V2 pair this token is priced/traded through. */
  pairAddress: Address | null;
  /** LP tokens: which settlement asset the pair quotes against. */
  pairedWith: "rhETH" | "USDG" | null;
  /** Stock tokens: Chainlink feed proxy (from config/chainlink-feeds.json). */
  chainlinkFeed: Address | null;
}

export class UnsupportedTokenError extends Error {}
export class TokenNotFoundError extends Error {}

const FEEDS_PATH = "./config/chainlink-feeds.json";

/** Operator-maintained token→Chainlink-feed map. Chainlink publishes the canonical
 *  list at docs.chain.link (Robinhood network page); copy addresses from there. */
function loadFeedMap(): Record<string, Address> {
  try {
    const raw = JSON.parse(fs.readFileSync(FEEDS_PATH, "utf8")) as Record<string, string>;
    return Object.fromEntries(
      Object.entries(raw)
        .filter(([k, v]) => /^0x[a-fA-F0-9]{40}$/.test(k) && /^0x[a-fA-F0-9]{40}$/.test(v))
        .map(([k, v]) => [k.toLowerCase(), v as Address]),
    );
  } catch {
    return {};
  }
}

async function tryRead<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * Classifies a token address into one of Little Jon's two tradable classes:
 *
 *  - "stock"  — exposes ERC-8056 `uiMultiplier()` (Robinhood Chain stock token).
 *               Priced via Chainlink, traded via 0x RFQ ↔ USDG.
 *  - "lp"     — plain ERC-20 with a live Uniswap V2 pair against USDG or rhETH.
 *               Priced via pair reserves, traded via the V2 router.
 *
 * Anything else — including bonding-curve tokens that have not graduated to a
 * Uniswap pool yet — is refused with UnsupportedTokenError, per the product rule
 * "only graduated tokens or anything with an LP in that sense".
 */
export async function classifyToken(address: Address): Promise<TokenInfo> {
  const addr = address.toLowerCase() as Address;

  const [symbol, name, decimals] = await Promise.all([
    tryRead(() => publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: "symbol" })),
    tryRead(() => publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: "name" })),
    tryRead(() => publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: "decimals" })),
  ]);

  if (symbol === null || decimals === null) {
    throw new UnsupportedTokenError(`${address} does not respond like an ERC-20 token`);
  }

  // Stock token? ERC-8056 surface is the discriminator.
  const uiMultiplier = await tryRead(() =>
    publicClient.readContract({ address: addr, abi: ERC8056_ABI, functionName: "uiMultiplier" }),
  );

  if (uiMultiplier !== null) {
    const feed = loadFeedMap()[addr] ?? null;
    return {
      address: addr,
      symbol,
      name: name ?? symbol,
      decimals,
      kind: "stock",
      pairAddress: null,
      pairedWith: null,
      chainlinkFeed: feed,
    };
  }

  // LP'd token? Look for a live Uniswap V2 pair against USDG (preferred settlement
  // asset), falling back to rhETH.
  if (!config.UNIV2_FACTORY_ADDRESS) {
    throw new UnsupportedTokenError(
      "UNIV2_FACTORY_ADDRESS is not configured — cannot verify LP for non-stock tokens. " +
        "Set it once Robinhood Chain's Uniswap V2 factory address is published.",
    );
  }
  const factory = config.UNIV2_FACTORY_ADDRESS as Address;

  for (const [quoteName, quoteAddr] of [
    ["USDG", config.USDG_ADDRESS],
    ["rhETH", config.RHETH_ADDRESS],
  ] as const) {
    const pair = await tryRead(() =>
      publicClient.readContract({
        address: factory,
        abi: UNIV2_FACTORY_ABI,
        functionName: "getPair",
        args: [addr, quoteAddr as Address],
      }),
    );
    if (!pair || pair === "0x0000000000000000000000000000000000000000") continue;

    const reserves = await tryRead(() =>
      publicClient.readContract({ address: pair, abi: UNIV2_PAIR_ABI, functionName: "getReserves" }),
    );
    if (!reserves || (reserves[0] === 0n && reserves[1] === 0n)) continue;

    return {
      address: addr,
      symbol,
      name: name ?? symbol,
      decimals,
      kind: "lp",
      pairAddress: pair.toLowerCase() as Address,
      pairedWith: quoteName,
      chainlinkFeed: null,
    };
  }

  throw new UnsupportedTokenError(
    `${symbol} (${address}) has no live Uniswap V2 pair against USDG or rhETH — ` +
      `Little Jon only trades stock tokens and graduated/LP'd tokens.`,
  );
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function saveToken(info: TokenInfo, holders: number | null): void {
  db.prepare(
    `INSERT INTO tokens
       (address, symbol, name, decimals, kind, pair_address, paired_with, chainlink_feed, holders, verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET
       symbol = excluded.symbol, name = excluded.name, decimals = excluded.decimals,
       kind = excluded.kind, pair_address = excluded.pair_address,
       paired_with = excluded.paired_with, chainlink_feed = excluded.chainlink_feed,
       holders = COALESCE(excluded.holders, tokens.holders),
       verified_at = excluded.verified_at`,
  ).run(
    info.address,
    info.symbol,
    info.name,
    info.decimals,
    info.kind,
    info.pairAddress,
    info.pairedWith,
    info.chainlinkFeed,
    holders,
    Math.floor(Date.now() / 1000),
  );
}

function rowToInfo(row: Record<string, unknown>): TokenInfo {
  return {
    address: row.address as Address,
    symbol: row.symbol as string,
    name: row.name as string,
    decimals: row.decimals as number,
    kind: row.kind as TokenKind,
    pairAddress: (row.pair_address as Address | null) ?? null,
    pairedWith: (row.paired_with as "rhETH" | "USDG" | null) ?? null,
    chainlinkFeed: (row.chainlink_feed as Address | null) ?? null,
  };
}

/** Already-verified token from the local registry, or undefined. */
export function getKnownToken(address: string): TokenInfo | undefined {
  const row = db
    .prepare(`SELECT * FROM tokens WHERE address = ? AND kind != 'unsupported'`)
    .get(address.toLowerCase()) as Record<string, unknown> | undefined;
  return row ? rowToInfo(row) : undefined;
}

// ---------------------------------------------------------------------------
// Resolution: user input (address or name) → verified TokenInfo
// ---------------------------------------------------------------------------

/**
 * Resolves whatever the user typed into a verified, tradable token.
 *
 *  - 0x address → classify directly on-chain.
 *  - name/symbol → local registry first (already-verified tokens), then a
 *    Blockscout search ranked by market cap → volume → holders, classifying the
 *    top candidates until one is tradable.
 */
export async function resolveToken(input: string): Promise<TokenInfo> {
  const trimmed = input.trim();

  if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
    const info = await classifyToken(trimmed as Address);
    saveToken(info, null);
    return info;
  }

  // Local registry hit?
  const cached = db
    .prepare(
      `SELECT * FROM tokens
       WHERE kind != 'unsupported' AND (symbol = ? COLLATE NOCASE OR name = ? COLLATE NOCASE)
       ORDER BY holders DESC NULLS LAST LIMIT 1`,
    )
    .get(trimmed, trimmed) as Record<string, unknown> | undefined;
  if (cached) {
    return rowToInfo(cached);
  }

  // Blockscout search, best-first, classify until something is tradable.
  const candidates = rankCandidates(trimmed, await searchTokens(trimmed));
  if (candidates.length === 0) {
    throw new TokenNotFoundError(`no token found on Robinhood Chain matching "${trimmed}"`);
  }

  const errors: string[] = [];
  for (const candidate of candidates.slice(0, 5)) {
    try {
      const info = await classifyToken(candidate.address as Address);
      saveToken(info, candidate.holders);
      logger.info(
        { input: trimmed, resolved: info.address, symbol: info.symbol, kind: info.kind },
        "resolved token by name",
      );
      return info;
    } catch (err) {
      if (err instanceof UnsupportedTokenError) {
        errors.push(err.message);
        continue;
      }
      throw err;
    }
  }

  throw new UnsupportedTokenError(
    `found ${candidates.length} match(es) for "${trimmed}" but none are tradable:\n` +
      errors.map((e) => `  - ${e}`).join("\n"),
  );
}
