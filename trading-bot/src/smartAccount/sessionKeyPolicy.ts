import fs from "node:fs";
import { z } from "zod";
import type { Address, Hex } from "viem";

/**
 * A session key policy scopes what the bot's hot key is allowed to do through the
 * ERC-4337 smart account. It is enforced twice:
 *
 *  1. Off-chain, here, before a UserOperation is even built — cheap, fast-failing.
 *  2. On-chain, by the smart account's session-key validator module (e.g. ZeroDev
 *     Kernel session key plugin, Safe{Core} session key module, or a bespoke
 *     validator) — this is the layer that actually matters for security, since the
 *     off-chain check only protects against bugs in *this* process, not a
 *     compromised process.
 *
 * The session key must be registered with the account's on-chain validator using the
 * *same* target/selector/value/expiry constraints as this file before it can be used,
 * otherwise the account will reject UserOperations signed by it. This scaffold does
 * not implement that on-chain registration (it is account-implementation-specific) —
 * wire it up against whichever AA account/module you deploy.
 */
export interface AllowedTarget {
  /** Contract the session key is allowed to call. */
  address: Address;
  /** 4-byte function selectors allowed on `address`. Empty = no calls allowed. */
  selectors: Hex[];
  /** Optional per-call native-value cap (wei) for calls to this target. */
  maxValueWei?: bigint;
}

export interface SessionKeyPolicy {
  allowedTargets: AllowedTarget[];
  /** Unix seconds. Session key is invalid before this time. */
  validAfter: number;
  /** Unix seconds. Session key is invalid at/after this time. */
  validUntil: number;
}

const policySchema = z.object({
  allowedTargets: z.array(
    z.object({
      address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      selectors: z.array(z.string().regex(/^0x[a-fA-F0-9]{8}$/)),
      maxValueWei: z.string().optional(),
    }),
  ),
  validAfter: z.number().int().nonnegative(),
  validUntil: z.number().int().positive(),
});

export function loadSessionKeyPolicy(path: string): SessionKeyPolicy {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  const parsed = policySchema.parse(raw);

  return {
    allowedTargets: parsed.allowedTargets.map((t) => ({
      address: t.address as Address,
      selectors: t.selectors as Hex[],
      maxValueWei: t.maxValueWei !== undefined ? BigInt(t.maxValueWei) : undefined,
    })),
    validAfter: parsed.validAfter,
    validUntil: parsed.validUntil,
  };
}

export class SessionKeyPolicyViolation extends Error {}

/**
 * Throws unless `{ target, selector, value }` is explicitly permitted by `policy` and
 * the policy hasn't expired. Call this immediately before building every UserOperation
 * — never construct calldata for an unchecked action "just this once."
 */
export function assertActionAllowed(
  policy: SessionKeyPolicy,
  action: { target: Address; selector: Hex; value: bigint },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): void {
  if (nowSeconds < policy.validAfter || nowSeconds >= policy.validUntil) {
    throw new SessionKeyPolicyViolation(
      `session key is not valid at ${nowSeconds} (window: ${policy.validAfter}-${policy.validUntil})`,
    );
  }

  const target = policy.allowedTargets.find(
    (t) => t.address.toLowerCase() === action.target.toLowerCase(),
  );
  if (!target) {
    throw new SessionKeyPolicyViolation(`target ${action.target} is not in the allowlist`);
  }

  const selectorAllowed = target.selectors.some(
    (s) => s.toLowerCase() === action.selector.toLowerCase(),
  );
  if (!selectorAllowed) {
    throw new SessionKeyPolicyViolation(
      `selector ${action.selector} is not allowed on target ${action.target}`,
    );
  }

  if (target.maxValueWei !== undefined && action.value > target.maxValueWei) {
    throw new SessionKeyPolicyViolation(
      `value ${action.value} exceeds max ${target.maxValueWei} for target ${action.target}`,
    );
  }
}
