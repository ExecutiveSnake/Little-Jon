import type { Address, Hex } from "viem";
import { config } from "../config.js";
import { logger } from "../logger.js";
import {
  assertActionAllowed,
  loadSessionKeyPolicy,
  type SessionKeyPolicy,
} from "../smartAccount/sessionKeyPolicy.js";

export interface Call {
  to: Address;
  value: bigint;
  data: Hex;
}

export interface SendResult {
  /** UserOperation/tx hash, or null in dry-run mode. */
  txHash: string | null;
  dryRun: boolean;
}

/**
 * Abstract execution backend. The watcher and CLI talk to this interface only;
 * the concrete backend is ZeroDev (Kernel smart account, EntryPoint v0.7) when
 * fully configured, and a loud dry-run logger otherwise — so every layer above
 * can be built, run, and tested before live execution is wired to real keys.
 */
export interface ExecutionBackend {
  readonly kind: "zerodev" | "dry-run";
  accountAddress(): Promise<Address>;
  sendCalls(calls: Call[], context: string): Promise<SendResult>;
}

let cachedPolicy: SessionKeyPolicy | undefined;
function policy(): SessionKeyPolicy {
  cachedPolicy ??= loadSessionKeyPolicy(config.SESSION_KEY_POLICY_PATH);
  return cachedPolicy;
}

/**
 * Off-chain session-key policy check applied to every call regardless of backend.
 * Second line of defense — the on-chain Kernel session-key validator (registered
 * with the same constraints) is the real enforcement.
 */
export function assertCallsAllowed(calls: Call[]): void {
  for (const call of calls) {
    assertActionAllowed(policy(), {
      target: call.to,
      selector: call.data.slice(0, 10) as Hex,
      value: call.value,
    });
  }
}

class DryRunBackend implements ExecutionBackend {
  readonly kind = "dry-run" as const;

  async accountAddress(): Promise<Address> {
    return (config.SMART_ACCOUNT_ADDRESS ?? "0x0000000000000000000000000000000000000000") as Address;
  }

  async sendCalls(calls: Call[], context: string): Promise<SendResult> {
    assertCallsAllowed(calls);
    logger.warn(
      {
        context,
        calls: calls.map((c) => ({ to: c.to, value: c.value.toString(), selector: c.data.slice(0, 10) })),
      },
      "DRY RUN — no ZeroDev config present; calls were validated but NOT sent",
    );
    return { txHash: null, dryRun: true };
  }
}

let backend: ExecutionBackend | undefined;

export async function getExecutionBackend(): Promise<ExecutionBackend> {
  if (backend) return backend;

  if (config.ZERODEV_RPC_URL && config.SESSION_KEY_PRIVATE_KEY) {
    const { createZeroDevBackend } = await import("./zerodev.js");
    backend = await createZeroDevBackend();
    logger.info({ account: await backend.accountAddress() }, "ZeroDev execution backend ready");
  } else {
    backend = new DryRunBackend();
    logger.warn(
      "execution running in DRY RUN mode — set ZERODEV_RPC_URL and SESSION_KEY_PRIVATE_KEY to go live",
    );
  }
  return backend;
}

/** Test seam. */
export function __setExecutionBackend(b: ExecutionBackend | undefined): void {
  backend = b;
}
