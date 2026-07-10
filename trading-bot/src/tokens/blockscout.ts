import { logger } from "../logger.js";

/** Shape of a token entry from Blockscout API v2 `/tokens?q=...`. */
export interface BlockscoutToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  holders: number;
  /** USD market cap where Blockscout knows it; null otherwise. */
  circulatingMarketCapUsd: number | null;
  /** 24h on-chain volume where known. */
  volumeUsd: number | null;
}

interface RawBlockscoutTokenItem {
  address?: string;
  address_hash?: string;
  symbol?: string | null;
  name?: string | null;
  decimals?: string | null;
  holders?: string | null;
  holders_count?: string | null;
  circulating_market_cap?: string | null;
  volume_24h?: string | null;
  type?: string;
}

function parseNum(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Searches the chain's Blockscout instance for ERC-20 tokens matching `query`
 * (name or symbol). Used to resolve user-typed names like "NVDA" or "dogewifhat"
 * to concrete addresses.
 */
export async function searchTokens(query: string, apiUrl: string): Promise<BlockscoutToken[]> {
  const url = `${apiUrl}/tokens?q=${encodeURIComponent(query)}&type=ERC-20`;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Blockscout token search failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { items?: RawBlockscoutTokenItem[] };
  const items = body.items ?? [];

  const tokens: BlockscoutToken[] = [];
  for (const item of items) {
    const address = (item.address ?? item.address_hash ?? "").toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(address)) continue;
    tokens.push({
      address,
      symbol: item.symbol ?? "",
      name: item.name ?? "",
      decimals: parseNum(item.decimals) ?? 18,
      holders: parseNum(item.holders ?? item.holders_count) ?? 0,
      circulatingMarketCapUsd: parseNum(item.circulating_market_cap),
      volumeUsd: parseNum(item.volume_24h),
    });
  }

  logger.debug({ query, found: tokens.length }, "blockscout token search");
  return tokens;
}

/**
 * Ranks name-search candidates the way the user asked: market cap first, then
 * volume, then holder count — "the one with the most volume, healthy activity and
 * other scrutiny", with MC as the primary key. Exact symbol matches outrank fuzzy
 * name matches at equal standing.
 */
export function rankCandidates(query: string, tokens: BlockscoutToken[]): BlockscoutToken[] {
  const q = query.trim().toLowerCase();
  return [...tokens].sort((a, b) => {
    const aExact = a.symbol.toLowerCase() === q || a.name.toLowerCase() === q ? 1 : 0;
    const bExact = b.symbol.toLowerCase() === q || b.name.toLowerCase() === q ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;

    const aMc = a.circulatingMarketCapUsd ?? 0;
    const bMc = b.circulatingMarketCapUsd ?? 0;
    if (aMc !== bMc) return bMc - aMc;

    const aVol = a.volumeUsd ?? 0;
    const bVol = b.volumeUsd ?? 0;
    if (aVol !== bVol) return bVol - aVol;

    return b.holders - a.holders;
  });
}
