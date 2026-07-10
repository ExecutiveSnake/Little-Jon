import type { Address, Hex } from "viem";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { TokenInfo } from "../tokens/registry.js";
import { VenueUnavailableError } from "./uniswapV2.js";

/**
 * 0x RFQ venue adapter for stock tokens (they trade via RFQ ↔ USDG at launch, per
 * docs.robinhood.com/chain/building-with-stock-tokens). The RFQ auction aggregates
 * competing market makers, so "best price" happens inside the quote — there is no
 * multi-venue routing to do on this leg.
 *
 * The exact API host for Robinhood Chain isn't published yet, so this client is
 * written against the standard 0x Swap API quote shape and gated on
 * ZEROX_RFQ_API_URL. Verify the response fields against the real endpoint before
 * first live trade.
 */

export interface RfqQuote {
  buyToken: Address;
  sellToken: Address;
  sellAmount: bigint;
  buyAmount: bigint;
  /** Quote-normalized execution price (USDG per token for both directions). */
  price: number;
  /** The settlement contract to call. Session-key policy must allowlist it. */
  to: Address;
  data: Hex;
  value: bigint;
  /** Token the smart account must approve (allowanceTarget / Permit2). */
  allowanceTarget: Address;
  expiresAt: number | null;
}

interface Raw0xQuote {
  buyAmount: string;
  sellAmount: string;
  price?: string;
  to: string;
  data: string;
  value?: string;
  allowanceTarget?: string;
  expiry?: string | number;
}

export async function fetchRfqQuote(
  token: TokenInfo,
  direction: "buy" | "sell",
  /** Exact input amount: USDG base units for buys, token base units for sells. */
  sellAmount: bigint,
  taker: Address,
): Promise<RfqQuote> {
  if (!config.ZEROX_RFQ_API_URL) {
    throw new VenueUnavailableError(
      "ZEROX_RFQ_API_URL is not configured — stock-token trading is disabled until the " +
        "0x RFQ endpoint for Robinhood Chain is set.",
    );
  }

  const usdg = config.USDG_ADDRESS as Address;
  const sellToken = direction === "buy" ? usdg : token.address;
  const buyToken = direction === "buy" ? token.address : usdg;

  const params = new URLSearchParams({
    chainId: String(config.CHAIN_ID),
    sellToken,
    buyToken,
    sellAmount: sellAmount.toString(),
    taker,
  });

  const response = await fetch(`${config.ZEROX_RFQ_API_URL}/quote?${params}`, {
    headers: {
      accept: "application/json",
      ...(config.ZEROX_API_KEY ? { "0x-api-key": config.ZEROX_API_KEY } : {}),
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "<unreadable>");
    throw new VenueUnavailableError(`0x RFQ quote failed: HTTP ${response.status}: ${body}`);
  }

  const raw = (await response.json()) as Raw0xQuote;
  if (!raw.to || !raw.data || !raw.buyAmount) {
    throw new VenueUnavailableError(`0x RFQ quote response missing fields: ${JSON.stringify(raw)}`);
  }

  const buyAmount = BigInt(raw.buyAmount);
  const sellAmt = BigInt(raw.sellAmount);

  // Normalize price to USDG-per-token regardless of direction. USDG decimals are
  // read lazily elsewhere; RFQ quotes use base units, so derive from the two legs
  // with the token's known decimals and 18 assumed for USDG unless overridden.
  const usdgDecimals = 18; // TODO(config): verify USDG decimals on-chain at startup
  const tokenAmount =
    direction === "buy" ? Number(buyAmount) / 10 ** token.decimals : Number(sellAmt) / 10 ** token.decimals;
  const usdgAmount =
    direction === "buy" ? Number(sellAmt) / 10 ** usdgDecimals : Number(buyAmount) / 10 ** usdgDecimals;
  const price = tokenAmount === 0 ? 0 : usdgAmount / tokenAmount;

  const quote: RfqQuote = {
    buyToken,
    sellToken,
    sellAmount: sellAmt,
    buyAmount,
    price,
    to: raw.to as Address,
    data: raw.data as Hex,
    value: BigInt(raw.value ?? "0"),
    allowanceTarget: (raw.allowanceTarget ?? raw.to) as Address,
    expiresAt: raw.expiry ? Number(raw.expiry) : null,
  };

  logger.debug(
    { symbol: token.symbol, direction, price: quote.price, buyAmount: raw.buyAmount },
    "0x RFQ quote",
  );
  return quote;
}
