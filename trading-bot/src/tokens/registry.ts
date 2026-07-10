import fs from "node:fs";
import type { Address } from "viem";
import { db } from "../db.js";
import { logger } from "../logger.js";
import {
  DEFAULT_CHAIN,
  evmClient,
  getChainDef,
  type ChainDef,
  type LjChainId,
} from "../chain/chains.js";
import { ERC20_ABI, ERC8056_ABI, UNIV2_FACTORY_ABI, UNIV2_PAIR_ABI } from "../chain/abis.js";
import { rankCandidates, searchTokens } from "./blockscout.js";
import { lookupMajor, majorFromKey, majorToken } from "./majors.js";

export type TokenKind = "stock" | "lp" | "major";

export interface TokenInfo {
  /** Chain this token instance lives on (majors: where the position executes). */
  chain: LjChainId;
  /** Storage key for DB rows (positions.token, price_points.token, tokens.address).
   *  robinhood = bare address, other EVM = '<chain>:<address>', majors = 'major:<SYM>'. */
  key: string;
  /** Raw on-chain address (zero address for majors). */
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  kind: TokenKind;
  /** LP tokens: the Uniswap V2 pair this token is priced/traded through. */
  pairAddress: Address | null;
  /** LP tokens: quote symbol ('USDG' | 'rhETH' | 'USDC' | 'WETH'); majors: 'USD'. */
  pairedWith: string | null;
  /** Stock tokens: Chainlink feed proxy (from config/chainlink-feeds.json). */
  chainlinkFeed: Address | null;
  /** Majors: Pyth price feed id. */
  pythFeedId?: string;
}

export class UnsupportedTokenError extends Error {}
export class TokenNotFoundError extends Error {}

export function tokenStorageKey(chain: LjChainId, address: string): string {
  const addr = address.toLowerCase();
  return chain === "robinhood" ? addr : `${chain}:${addr}`;
}

const FEEDS_PATH = "./config/chainlink-feeds.json";

/** Operator-maintained token→Chainlink-feed map (Robinhood Chain stock tokens). */
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
 * Classifies an EVM token address into one of Little Jon's tradable classes:
 *
 *  - "stock"  — exposes ERC-8056 `uiMultiplier()` (Robinhood Chain stock token).
 *               Priced via Chainlink, traded via 0x RFQ ↔ USDG.
 *  - "lp"     — plain ERC-20 with a live Uniswap V2 pair against the chain's
 *               USD or ETH quote asset. Priced via reserves, traded via the router.
 *
 * Anything else — including bonding-curve tokens that have not graduated to a
 * pool yet — is refused with UnsupportedTokenError.
 */
export async function classifyToken(address: Address, chain: ChainDef): Promise<TokenInfo> {
  const addr = address.toLowerCase() as Address;
  const client = evmClient(chain);

  const [symbol, name, decimals] = await Promise.all([
    tryRead(() => client.readContract({ address: addr, abi: ERC20_ABI, functionName: "symbol" })),
    tryRead(() => client.readContract({ address: addr, abi: ERC20_ABI, functionName: "name" })),
    tryRead(() => client.readContract({ address: addr, abi: ERC20_ABI, functionName: "decimals" })),
  ]);

  if (symbol === null || decimals === null) {
    throw new UnsupportedTokenError(`${address} does not respond like an ERC-20 token`);
  }

  const base = {
    chain: chain.id,
    key: tokenStorageKey(chain.id, addr),
    address: addr,
    symbol,
    name: name ?? symbol,
    decimals,
  };

  // Stock token? ERC-8056 surface is the discriminator (Robinhood Chain only).
  if (chain.id === "robinhood") {
    const uiMultiplier = await tryRead(() =>
      client.readContract({ address: addr, abi: ERC8056_ABI, functionName: "uiMultiplier" }),
    );
    if (uiMultiplier !== null) {
      return {
        ...base,
        kind: "stock",
        pairAddress: null,
        pairedWith: null,
        chainlinkFeed: loadFeedMap()[addr] ?? null,
      };
    }
  }

  // LP'd token? Look for a live Uniswap V2 pair against the chain's USD quote
  // (preferred settlement asset), falling back to the ETH quote.
  if (!chain.univ2Factory) {
    throw new UnsupportedTokenError(
      `no Uniswap V2 factory configured for ${chain.displayName} — cannot verify LP for ` +
        `non-stock tokens on this chain.`,
    );
  }

  const quotes = [chain.usdQuote, chain.ethQuote].filter(
    (q): q is NonNullable<typeof q> => q !== undefined,
  );
  for (const quote of quotes) {
    const pair = await tryRead(() =>
      client.readContract({
        address: chain.univ2Factory!,
        abi: UNIV2_FACTORY_ABI,
        functionName: "getPair",
        args: [addr, quote.address],
      }),
    );
    if (!pair || pair === "0x0000000000000000000000000000000000000000") continue;

    const reserves = await tryRead(() =>
      client.readContract({ address: pair, abi: UNIV2_PAIR_ABI, functionName: "getReserves" }),
    );
    if (!reserves || (reserves[0] === 0n && reserves[1] === 0n)) continue;

    return {
      ...base,
      kind: "lp",
      pairAddress: pair.toLowerCase() as Address,
      pairedWith: quote.symbol,
      chainlinkFeed: null,
    };
  }

  throw new UnsupportedTokenError(
    `${symbol} (${address}) has no live Uniswap V2 pair against ` +
      `${quotes.map((q) => q.symbol).join(" or ")} on ${chain.displayName} — ` +
      `Little Jon only trades stock tokens and graduated/LP'd tokens.`,
  );
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function saveToken(info: TokenInfo, holders: number | null): void {
  db.prepare(
    `INSERT INTO tokens
       (address, chain, symbol, name, decimals, kind, pair_address, paired_with, chainlink_feed, holders, verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET
       chain = excluded.chain,
       symbol = excluded.symbol, name = excluded.name, decimals = excluded.decimals,
       kind = excluded.kind, pair_address = excluded.pair_address,
       paired_with = excluded.paired_with, chainlink_feed = excluded.chainlink_feed,
       holders = COALESCE(excluded.holders, tokens.holders),
       verified_at = excluded.verified_at`,
  ).run(
    info.key,
    info.chain,
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
  const key = row.address as string;
  const chain = (row.chain as LjChainId) ?? "robinhood";
  const rawAddress = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key;
  return {
    chain,
    key,
    address: rawAddress as Address,
    symbol: row.symbol as string,
    name: row.name as string,
    decimals: row.decimals as number,
    kind: row.kind as TokenKind,
    pairAddress: (row.pair_address as Address | null) ?? null,
    pairedWith: (row.paired_with as string | null) ?? null,
    chainlinkFeed: (row.chainlink_feed as Address | null) ?? null,
  };
}

/** Already-verified token by storage key, or undefined. Majors resolve without DB. */
export function getKnownToken(key: string, chain: LjChainId = DEFAULT_CHAIN): TokenInfo | undefined {
  const major = majorFromKey(key, chain);
  if (major) return major;
  const row = db
    .prepare(`SELECT * FROM tokens WHERE address = ? AND kind != 'unsupported'`)
    .get(key.toLowerCase()) as Record<string, unknown> | undefined;
  return row ? rowToInfo(row) : undefined;
}

// ---------------------------------------------------------------------------
// Resolution: user input (address or name) → verified TokenInfo
// ---------------------------------------------------------------------------

/**
 * Resolves whatever the user typed into a verified, tradable token on a chain.
 *
 *  - Solana: major assets only (SOL, ETH, BTC, …), oracle-priced via Pyth.
 *  - EVM chains: 0x address → classify on-chain; name/symbol → local registry,
 *    then a Blockscout search ranked by market cap → volume → holders. When
 *    nothing on-chain matches but the input names a major asset, fall back to
 *    the oracle-priced major.
 */
export async function resolveToken(
  input: string,
  chainId: string = DEFAULT_CHAIN,
): Promise<TokenInfo> {
  const trimmed = input.trim();
  const chain = getChainDef(chainId);

  if (chain.kind === "solana") {
    const major = lookupMajor(trimmed);
    if (!major) {
      throw new UnsupportedTokenError(
        `on Solana, Little Jon currently supports major assets only (e.g. SOL, ETH, BTC) — ` +
          `"${trimmed}" is not one of them`,
      );
    }
    return majorToken(major, chain.id);
  }

  if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
    const info = await classifyToken(trimmed as Address, chain);
    saveToken(info, null);
    return info;
  }

  // Local registry hit?
  const cached = db
    .prepare(
      `SELECT * FROM tokens
       WHERE kind != 'unsupported' AND chain = ?
         AND (symbol = ? COLLATE NOCASE OR name = ? COLLATE NOCASE)
       ORDER BY holders DESC NULLS LAST LIMIT 1`,
    )
    .get(chain.id, trimmed, trimmed) as Record<string, unknown> | undefined;
  if (cached) {
    return rowToInfo(cached);
  }

  // Blockscout search, best-first, classify until something is tradable.
  const errors: string[] = [];
  let candidateCount = 0;
  try {
    const candidates = rankCandidates(trimmed, await searchTokens(trimmed, chain.blockscoutApiUrl!));
    candidateCount = candidates.length;
    for (const candidate of candidates.slice(0, 5)) {
      try {
        const info = await classifyToken(candidate.address as Address, chain);
        saveToken(info, candidate.holders);
        logger.info(
          { input: trimmed, resolved: info.address, symbol: info.symbol, kind: info.kind, chain: chain.id },
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
  } catch (err) {
    if (!(err instanceof UnsupportedTokenError) && !(err instanceof TokenNotFoundError)) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  // Nothing tradable on-chain — a major asset name still resolves via Pyth.
  const major = lookupMajor(trimmed);
  if (major) return majorToken(major, chain.id);

  if (candidateCount === 0) {
    throw new TokenNotFoundError(
      `no token found on ${chain.displayName} matching "${trimmed}"`,
    );
  }
  throw new UnsupportedTokenError(
    `found ${candidateCount} match(es) for "${trimmed}" on ${chain.displayName} but none are tradable:\n` +
      errors.map((e) => `  - ${e}`).join("\n"),
  );
}
