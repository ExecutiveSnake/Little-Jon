import { ethers } from "ethers";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { creditsContractRead, creditsContractSubscribe, httpProvider, wsProvider } from "./contract.js";
import { getLastIndexedBlock, recordDepositEvent, setLastIndexedBlock } from "../store/idempotencyStore.js";

type DepositEventArgs = [
  user: string,
  usdeAmount: bigint,
  creditsMinted: bigint,
  costPerCall: bigint,
  marginBps: bigint,
];

function handleDepositLog(log: ethers.EventLog | ethers.Log): void {
  if (!("args" in log)) return; // raw Log without decoded args, shouldn't happen via contract filter
  const [user, usdeAmount, creditsMinted] = log.args as unknown as DepositEventArgs;

  recordDepositEvent({
    txHash: log.transactionHash,
    logIndex: log.index,
    userAddress: user,
    usdeAmount,
    creditsMinted,
    blockNumber: log.blockNumber,
  });

  logger.info(
    { user, usdeAmount: usdeAmount.toString(), creditsMinted: creditsMinted.toString(), tx: log.transactionHash },
    "indexed Deposit event",
  );

  setLastIndexedBlock(log.blockNumber);
}

/// Re-scans any blocks that may have been missed while the service was offline (or the
/// WS connection was down) using the HTTP provider, which doesn't depend on a live
/// socket. Bounded by DEPOSIT_BACKFILL_BLOCKS on first run so we don't try to replay
/// the entire chain history.
async function backfillMissedDeposits(): Promise<void> {
  const currentBlock = await httpProvider.getBlockNumber();
  const lastIndexed = getLastIndexedBlock();
  const fromBlock = lastIndexed !== undefined
    ? lastIndexed + 1
    : Math.max(currentBlock - config.DEPOSIT_BACKFILL_BLOCKS, 0);

  if (fromBlock > currentBlock) return;

  logger.info({ fromBlock, currentBlock }, "backfilling Deposit events");

  const filter = creditsContractRead.filters.Deposit();
  const logs = await creditsContractRead.queryFilter(filter, fromBlock, currentBlock);

  for (const log of logs) {
    handleDepositLog(log);
  }

  setLastIndexedBlock(currentBlock);
}

/// Subscribes to live Deposit events over the Alchemy WebSocket endpoint. On
/// disconnect, ethers' WebSocketProvider will surface an error/close event; we log it
/// and rely on the process supervisor (systemd/pm2/k8s) to restart the service, which
/// re-runs `backfillMissedDeposits` on boot to close any gap.
export function startDepositListener(): void {
  creditsContractSubscribe.on("Deposit", (...args) => {
    const log = args[args.length - 1] as ethers.EventLog;
    handleDepositLog(log);
  });

  const ws = wsProvider.websocket as unknown as {
    on?: (event: string, cb: (...a: unknown[]) => void) => void;
  };
  ws.on?.("close", (code: unknown) => {
    logger.error({ code }, "Alchemy WS connection closed — deposit indexing paused until restart");
  });
  ws.on?.("error", (err: unknown) => {
    logger.error({ err }, "Alchemy WS connection error");
  });

  logger.info("subscribed to Deposit events over WebSocket");
}

export async function initDepositIndexer(): Promise<void> {
  await backfillMissedDeposits();
  startDepositListener();
}
