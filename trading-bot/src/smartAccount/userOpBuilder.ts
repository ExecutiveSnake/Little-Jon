import {
  concat,
  encodeAbiParameters,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { publicClient } from "../chain/clients.js";
import { config } from "../config.js";

/**
 * ERC-4337 (EntryPoint v0.6) UserOperation. This scaffold builds and signs the struct
 * manually with viem so the flow is fully inspectable, rather than depending on a
 * higher-level AA SDK whose API surface changes frequently. Swap in
 * permissionless.js / your account vendor's SDK for production use if preferred —
 * the shape (and the session-key-scoping requirement) stays the same either way.
 */
export interface UserOperation {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymasterAndData: Hex;
  signature: Hex;
}

const sessionKeyAccount = privateKeyToAccount(config.SESSION_KEY_PRIVATE_KEY as Hex);

export function sessionKeySignerAddress(): Address {
  return sessionKeyAccount.address;
}

function packUserOp(op: Omit<UserOperation, "signature">): Hex {
  return encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes32" },
    ],
    [
      op.sender,
      op.nonce,
      keccak256(op.initCode),
      keccak256(op.callData),
      op.callGasLimit,
      op.verificationGasLimit,
      op.preVerificationGas,
      op.maxFeePerGas,
      op.maxPriorityFeePerGas,
      keccak256(op.paymasterAndData),
    ],
  );
}

/// Computes the EIP-4337 userOpHash: keccak256(abi.encode(packedUserOp, entryPoint, chainId)).
export function getUserOpHash(op: Omit<UserOperation, "signature">): Hex {
  const packed = packUserOp(op);
  const packedHash = keccak256(packed);
  const encoded = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
    [packedHash, config.ENTRYPOINT_ADDRESS as Address, BigInt(config.CHAIN_ID)],
  );
  return keccak256(encoded);
}

/// Signs a UserOperation with the scoped session key. Callers must have already run
/// the action through `assertActionAllowed` for every call encoded in `callData` —
/// this function has no knowledge of the session-key policy and will happily sign
/// anything it's handed.
///
/// Uses EIP-191 personal-sign over the raw userOpHash (i.e. signs
/// `keccak256("\x19Ethereum Signed Message:\n32" + userOpHash)`), matching the
/// `ECDSA.recover(userOpHash.toEthSignedMessageHash(), signature)` check used by
/// SimpleAccount and most of its derivatives. Some account/validator implementations
/// (e.g. Safe modules) instead recover over the raw, unprefixed hash — check your
/// specific account's validator before relying on this against real infra.
export async function signUserOperation(
  op: Omit<UserOperation, "signature">,
): Promise<UserOperation> {
  const hash = getUserOpHash(op);
  const signature = await sessionKeyAccount.signMessage({ message: { raw: hash } });
  return { ...op, signature };
}

/// Fills gas/fee fields with values from the bundler's `eth_estimateUserOperationGas`
/// and the chain's current fee data, then submits via `eth_sendUserOperation`.
export async function estimateAndSubmitUserOperation(
  partialOp: Omit<UserOperation, "signature" | "callGasLimit" | "verificationGasLimit" | "preVerificationGas" | "maxFeePerGas" | "maxPriorityFeePerGas">,
): Promise<Hex> {
  const fees = await publicClient.estimateFeesPerGas();

  const unsigned: Omit<UserOperation, "signature"> = {
    ...partialOp,
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    maxFeePerGas: fees.maxFeePerGas ?? 0n,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n,
  };

  const gasEstimate = await bundlerRpc<{
    callGasLimit: Hex;
    verificationGasLimit: Hex;
    preVerificationGas: Hex;
  }>("eth_estimateUserOperationGas", [
    serializeUserOp({ ...unsigned, signature: "0x" }),
    config.ENTRYPOINT_ADDRESS,
  ]);

  const finalOp: Omit<UserOperation, "signature"> = {
    ...unsigned,
    callGasLimit: BigInt(gasEstimate.callGasLimit),
    verificationGasLimit: BigInt(gasEstimate.verificationGasLimit),
    preVerificationGas: BigInt(gasEstimate.preVerificationGas),
  };

  const signed = await signUserOperation(finalOp);

  const userOpHash = await bundlerRpc<Hex>("eth_sendUserOperation", [
    serializeUserOp(signed),
    config.ENTRYPOINT_ADDRESS,
  ]);

  return userOpHash;
}

function serializeUserOp(op: UserOperation): Record<string, string> {
  return {
    sender: op.sender,
    nonce: toHex(op.nonce),
    initCode: op.initCode,
    callData: op.callData,
    callGasLimit: toHex(op.callGasLimit),
    verificationGasLimit: toHex(op.verificationGasLimit),
    preVerificationGas: toHex(op.preVerificationGas),
    maxFeePerGas: toHex(op.maxFeePerGas),
    maxPriorityFeePerGas: toHex(op.maxPriorityFeePerGas),
    paymasterAndData: op.paymasterAndData,
    signature: op.signature,
  };
}

let bundlerRequestId = 0;

async function bundlerRpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(config.BUNDLER_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++bundlerRequestId, method, params }),
  });

  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) {
    throw new Error(`bundler RPC ${method} failed: ${body.error.message}`);
  }
  return body.result as T;
}

export function encodeExecuteCallData(target: Address, value: bigint, data: Hex): Hex {
  // Matches the common `execute(address target, uint256 value, bytes data)` selector
  // used by most ERC-4337 smart account implementations (SimpleAccount, Kernel, etc.).
  // Confirm this matches your deployed account's ABI before using in production.
  const selector = "0xb61d27f6" as Hex; // execute(address,uint256,bytes)
  const encodedArgs = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "bytes" }],
    [target, value, data],
  );
  return concat([selector, encodedArgs]);
}
