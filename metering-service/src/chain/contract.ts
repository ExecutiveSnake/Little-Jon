import { ethers } from "ethers";
import { config } from "../config.js";
import { ANALYSIS_CREDITS_ABI } from "./abi.js";
import { logger } from "../logger.js";

// ethers' human-readable ABI typing can't infer method/filter signatures, so give the
// contract instance an explicit, hand-maintained interface matching AnalysisCredits.sol.
type AnalysisCreditsContract = ethers.Contract & {
  credits(user: string): Promise<bigint>;
  debitCredit(user: string, calls: bigint): Promise<ethers.ContractTransactionResponse>;
  filters: {
    Deposit: (user?: string | null) => ethers.DeferredTopicFilter;
  };
  on(
    event: "Deposit",
    listener: (
      user: string,
      usdeAmount: bigint,
      creditsMinted: bigint,
      costPerCall: bigint,
      marginBps: bigint,
      log: ethers.EventLog,
    ) => void,
  ): Promise<ethers.Contract>;
};

// WebSocket provider for live event subscription; HTTP provider for reads/writes so
// transaction submission and balance checks survive a flaky WS connection.
export const wsProvider = new ethers.WebSocketProvider(config.ALCHEMY_WSS_URL);
export const httpProvider = new ethers.JsonRpcProvider(config.ALCHEMY_HTTPS_URL);

export const relayerWallet = new ethers.Wallet(config.RELAYER_PRIVATE_KEY, httpProvider);

export const creditsContractRead = new ethers.Contract(
  config.ANALYSIS_CREDITS_ADDRESS,
  ANALYSIS_CREDITS_ABI,
  httpProvider,
) as unknown as AnalysisCreditsContract;

export const creditsContractWrite = new ethers.Contract(
  config.ANALYSIS_CREDITS_ADDRESS,
  ANALYSIS_CREDITS_ABI,
  relayerWallet,
) as unknown as AnalysisCreditsContract;

export const creditsContractSubscribe = new ethers.Contract(
  config.ANALYSIS_CREDITS_ADDRESS,
  ANALYSIS_CREDITS_ABI,
  wsProvider,
) as unknown as AnalysisCreditsContract;

/// Reads a user's on-chain credit balance directly (source of truth; the local
/// indexer/cache is only an optimization, never trusted for the final decision).
export async function getOnChainCreditBalance(user: string): Promise<bigint> {
  return creditsContractRead.credits(user);
}

/// Submits `debitCredit(user, calls)` from the relayer wallet. Confirms one block before
/// returning so callers can treat the credit burn as final once this resolves.
export async function debitCreditOnChain(user: string, calls: bigint): Promise<string> {
  const tx = await creditsContractWrite.debitCredit(user, calls);
  logger.info({ user, calls, txHash: tx.hash }, "submitted debitCredit tx");
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`debitCredit tx failed: ${tx.hash}`);
  }
  return tx.hash;
}
