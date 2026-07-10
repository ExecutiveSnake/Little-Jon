import { getOnChainCreditBalance, debitCreditOnChain } from "../chain/contract.js";
import { runAnalysis, type AnalysisRequestPayload, type AnalysisResult } from "./analysisClient.js";
import {
  createPendingRequest,
  getRequest,
  markDebited,
  markDelivered,
  markFailed,
} from "../store/idempotencyStore.js";
import { logger } from "../logger.js";

export class InsufficientCreditsError extends Error {
  constructor(
    public readonly userAddress: string,
    public readonly available: bigint,
    public readonly required: bigint,
  ) {
    super(`insufficient credits: user ${userAddress} has ${available}, needs ${required}`);
  }
}

/**
 * Processes an analysis request idempotently.
 *
 * Invariants:
 *  - Never calls debitCredit unless `runAnalysis` has already succeeded for this
 *    idempotency key (either just now, or on a prior attempt).
 *  - A retry with the same idempotencyKey never re-charges credits once the on-chain
 *    debit has confirmed ('debited' is terminal and short-circuits immediately).
 *  - A retry with the same idempotencyKey never re-calls the (potentially costly)
 *    upstream model API once analysis has already been delivered ('delivered' skips
 *    straight to the debit step).
 */
export async function processAnalysisRequest(
  idempotencyKey: string,
  userAddress: string,
  calls: number,
  payload: AnalysisRequestPayload,
): Promise<AnalysisResult> {
  const existing = getRequest(idempotencyKey);

  if (existing) {
    if (existing.userAddress.toLowerCase() !== userAddress.toLowerCase() || existing.calls !== calls) {
      throw new Error(
        `idempotency key ${idempotencyKey} was previously used with different parameters`,
      );
    }

    if (existing.status === "debited" || existing.status === "delivered") {
      // Already delivered at least once; result is cached, so no need to touch the
      // model API again. If the debit itself is still outstanding, finish it now.
      const result = JSON.parse(existing.analysisResult!) as AnalysisResult;
      if (existing.status === "delivered") {
        await settleDebit(idempotencyKey, userAddress, calls);
      }
      return result;
    }

    // status === 'pending' or 'failed': safe to retry the whole flow. A previous
    // attempt never reached 'delivered', so the model API is not known to have
    // succeeded, and no on-chain debit could have happened.
  } else {
    const balance = await getOnChainCreditBalance(userAddress);
    if (balance < BigInt(calls)) {
      throw new InsufficientCreditsError(userAddress, balance, BigInt(calls));
    }

    const created = createPendingRequest(idempotencyKey, userAddress, calls);
    if (!created) {
      // Lost a race with a concurrent request using the same key — recurse once to
      // pick up whatever state the winner left behind.
      return processAnalysisRequest(idempotencyKey, userAddress, calls, payload);
    }
  }

  let result: AnalysisResult;
  try {
    result = await runAnalysis(payload);
  } catch (err) {
    markFailed(idempotencyKey, err instanceof Error ? err.message : String(err));
    throw err;
  }

  // Analysis has been delivered as of this point — persist it before attempting the
  // debit so a crash between here and the debit confirming can still recover and
  // finish the debit (via the 'delivered' branch above) without calling the model
  // API a second time.
  markDelivered(idempotencyKey, JSON.stringify(result));

  await settleDebit(idempotencyKey, userAddress, calls);

  return result;
}

async function settleDebit(idempotencyKey: string, userAddress: string, calls: number): Promise<void> {
  try {
    const txHash = await debitCreditOnChain(userAddress, BigInt(calls));
    markDebited(idempotencyKey, txHash);
  } catch (err) {
    // Analysis was already delivered and is cached — we deliberately do NOT mark this
    // 'failed' (that would allow a future retry to re-call the model API). The record
    // stays 'delivered' so the next retry (triggered by the caller, or an operator
    // reconciliation job) retries only the debit.
    logger.error({ err, idempotencyKey, userAddress, calls }, "debitCredit failed after delivery");
    throw err;
  }
}
