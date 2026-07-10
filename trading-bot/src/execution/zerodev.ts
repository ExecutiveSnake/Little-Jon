import type { Address } from "viem";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { robinhoodChain } from "../chain/clients.js";
import { assertCallsAllowed, type Call, type ExecutionBackend, type SendResult } from "./backend.js";

/**
 * ZeroDev Kernel execution backend (EntryPoint v0.7), following the integration
 * shape from docs.robinhood.com/chain (Account Abstraction → ZeroDev).
 *
 * IMPORTANT — key model: v1 signs with a single ECDSA "sudo" signer on the Kernel
 * account, which is acceptable only while that key is the bot's own dedicated
 * account. The production posture the user chose is session keys: register a
 * scoped session key on the Kernel account via @zerodev/permissions (allowlisting
 * exactly the router / RFQ settler / token approvals with expiry), hold ONLY that
 * session key here, and keep the owner key offline. The off-chain policy check in
 * backend.ts (assertCallsAllowed) applies either way; swap the validator wiring
 * below when enabling on-chain session keys.
 */
export async function createZeroDevBackend(): Promise<ExecutionBackend> {
  const [{ createKernelAccount, createKernelAccountClient, createZeroDevPaymasterClient }, { signerToEcdsaValidator }, constants] =
    await Promise.all([
      import("@zerodev/sdk"),
      import("@zerodev/ecdsa-validator"),
      import("@zerodev/sdk/constants"),
    ]);

  const zerodevRpc = config.ZERODEV_RPC_URL!;
  const signer = privateKeyToAccount(config.SESSION_KEY_PRIVATE_KEY as `0x${string}`);
  const entryPoint = constants.getEntryPoint("0.7");
  const kernelVersion = constants.KERNEL_V3_1;

  const publicClient = createPublicClient({
    transport: http(config.CHAIN_RPC_URL),
    chain: robinhoodChain,
  });

  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer,
    entryPoint,
    kernelVersion,
  });

  const account = await createKernelAccount(publicClient, {
    plugins: { sudo: ecdsaValidator },
    entryPoint,
    kernelVersion,
  });

  const paymaster = createZeroDevPaymasterClient({
    chain: robinhoodChain,
    transport: http(zerodevRpc),
  });

  const kernelClient = createKernelAccountClient({
    account,
    chain: robinhoodChain,
    bundlerTransport: http(zerodevRpc),
    client: publicClient,
    paymaster: {
      getPaymasterData(userOperation) {
        return paymaster.sponsorUserOperation({ userOperation });
      },
    },
  });

  return {
    kind: "zerodev" as const,

    async accountAddress(): Promise<Address> {
      return account.address;
    },

    async sendCalls(calls: Call[], context: string): Promise<SendResult> {
      assertCallsAllowed(calls);

      const userOpHash = await kernelClient.sendUserOperation({
        callData: await account.encodeCalls(
          calls.map((c) => ({ to: c.to, value: c.value, data: c.data })),
        ),
      });

      logger.info({ context, userOpHash }, "UserOperation submitted");

      const receipt = await kernelClient.waitForUserOperationReceipt({
        hash: userOpHash,
        timeout: 60_000,
      });
      if (!receipt.success) {
        throw new Error(`UserOperation reverted: ${userOpHash} (${context})`);
      }

      return { txHash: receipt.receipt.transactionHash, dryRun: false };
    },
  };
}
