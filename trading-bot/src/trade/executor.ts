import type { Address, Hex } from "viem";
import { config } from "../config.js";
import { publicClient } from "../chain/clients.js";
import { logger } from "../logger.js";
import { readStockTokenPrice } from "../oracle/chainlinkPriceFeed.js";
import { requestAnalysis, type AnalysisResult } from "../analysis/meteringClient.js";
import {
  assertActionAllowed,
  loadSessionKeyPolicy,
  type SessionKeyPolicy,
} from "../smartAccount/sessionKeyPolicy.js";
import {
  encodeExecuteCallData,
  estimateAndSubmitUserOperation,
} from "../smartAccount/userOpBuilder.js";
import {
  assertPositionSizeAllowed,
  assertSafeToProposeTrade,
  assertSlippageAllowed,
} from "../risk/guardrails.js";

export interface TradeRequest {
  symbol: string;
  kind: "token" | "stock-token";
  chainlinkFeed: Address;
  /** Contract the trade actually executes against (DEX router, etc.). */
  targetContract: Address;
  /** 4-byte selector of the call being made on `targetContract`. */
  selector: Hex;
  /** Fully-encoded calldata for the trade, built by the caller's strategy/DEX layer. */
  callData: Hex;
  /** Native value (wei) to send with the call, if any. */
  value: bigint;
  /** Notional size of the trade in USD, for the position-size guardrail. */
  notionalUsd: number;
  /** Price this trade would actually execute at (e.g. from a DEX quote), for the slippage guardrail. */
  quotedPrice: number;
}

/**
 * Strategy-specific gate on the analysis result — override to decide whether to
 * proceed once analysis comes back (e.g. only trade if `score` clears some
 * threshold). Defaults to "always proceed"; wire in real decision logic before
 * running this against real funds.
 */
export type AnalysisGate = (analysis: AnalysisResult) => boolean;

const defaultAnalysisGate: AnalysisGate = () => true;

let cachedPolicy: SessionKeyPolicy | undefined;
function getSessionKeyPolicy(): SessionKeyPolicy {
  cachedPolicy ??= loadSessionKeyPolicy(config.SESSION_KEY_POLICY_PATH);
  return cachedPolicy;
}

export class TradeAbortedError extends Error {}

/**
 * End-to-end guarded trade execution:
 *   1. Kill switch + daily loss circuit breaker.
 *   2. Position size cap.
 *   3. Chainlink reference price + slippage cap.
 *   4. Mandatory AI analysis via the metering service (gated, never skipped).
 *   5. Session-key policy check on the exact call about to be made.
 *   6. Build + sign + submit the UserOperation through the ERC-4337 bundler.
 *
 * Any guardrail failure aborts the trade before a UserOperation is ever built —
 * nothing here is best-effort.
 */
export async function executeGuardedTrade(
  request: TradeRequest,
  analysisGate: AnalysisGate = defaultAnalysisGate,
): Promise<Hex> {
  assertSafeToProposeTrade();
  assertPositionSizeAllowed(request.notionalUsd);

  const reference = await readStockTokenPrice(request.chainlinkFeed);
  assertSlippageAllowed(reference.price, request.quotedPrice);

  const analysis = await requestAnalysis(request.symbol, request.kind);
  if (!analysisGate(analysis)) {
    throw new TradeAbortedError(
      `analysis gate rejected trade for ${request.symbol}: ${analysis.summary}`,
    );
  }

  const policy = getSessionKeyPolicy();
  assertActionAllowed(policy, {
    target: request.targetContract,
    selector: request.selector,
    value: request.value,
  });

  const executeCallData = encodeExecuteCallData(
    request.targetContract,
    request.value,
    request.callData,
  );

  logger.info(
    { symbol: request.symbol, notionalUsd: request.notionalUsd, target: request.targetContract },
    "submitting guarded trade UserOperation",
  );

  const userOpHash = await estimateAndSubmitUserOperation({
    sender: config.SMART_ACCOUNT_ADDRESS as Address,
    nonce: await getAccountNonce(),
    initCode: "0x",
    callData: executeCallData,
    paymasterAndData: "0x",
  });

  logger.info({ userOpHash }, "trade UserOperation submitted");

  return userOpHash;
}

const ENTRYPOINT_GET_NONCE_ABI = [
  {
    type: "function",
    name: "getNonce",
    stateMutability: "view",
    inputs: [
      { name: "sender", type: "address" },
      { name: "key", type: "uint192" },
    ],
    outputs: [{ name: "nonce", type: "uint256" }],
  },
] as const;

/// Reads the account's next nonce from EntryPoint using nonce key 0 (sequential
/// nonces). If your account implementation uses 2D/parallel nonces with a non-zero
/// key, pass the right key through here instead of hardcoding 0n.
async function getAccountNonce(): Promise<bigint> {
  return publicClient.readContract({
    address: config.ENTRYPOINT_ADDRESS as Address,
    abi: ENTRYPOINT_GET_NONCE_ABI,
    functionName: "getNonce",
    args: [config.SMART_ACCOUNT_ADDRESS as Address, 0n],
  });
}
