import "./setupEnv.js";
import { describe, expect, it } from "vitest";
import {
  assertActionAllowed,
  SessionKeyPolicyViolation,
  type SessionKeyPolicy,
} from "../src/smartAccount/sessionKeyPolicy.js";

const ROUTER = "0x0000000000000000000000000000000000dEAD" as const;
const OTHER = "0x0000000000000000000000000000000000bEEF" as const;
const SWAP_SELECTOR = "0x38ed1739" as const;
const OTHER_SELECTOR = "0xa9059cbb" as const;

function makePolicy(overrides: Partial<SessionKeyPolicy> = {}): SessionKeyPolicy {
  return {
    allowedTargets: [
      { address: ROUTER, selectors: [SWAP_SELECTOR], maxValueWei: 1_000n },
    ],
    validAfter: 0,
    validUntil: 4_102_444_800,
    ...overrides,
  };
}

describe("assertActionAllowed", () => {
  it("allows a call matching an allowlisted target/selector within the value cap", () => {
    const policy = makePolicy();
    expect(() =>
      assertActionAllowed(policy, { target: ROUTER, selector: SWAP_SELECTOR, value: 500n }),
    ).not.toThrow();
  });

  it("rejects a target not on the allowlist", () => {
    const policy = makePolicy();
    expect(() =>
      assertActionAllowed(policy, { target: OTHER, selector: SWAP_SELECTOR, value: 0n }),
    ).toThrow(SessionKeyPolicyViolation);
  });

  it("rejects a selector not allowed on an otherwise-allowed target", () => {
    const policy = makePolicy();
    expect(() =>
      assertActionAllowed(policy, { target: ROUTER, selector: OTHER_SELECTOR, value: 0n }),
    ).toThrow(SessionKeyPolicyViolation);
  });

  it("rejects a value exceeding the per-target cap", () => {
    const policy = makePolicy();
    expect(() =>
      assertActionAllowed(policy, { target: ROUTER, selector: SWAP_SELECTOR, value: 1_001n }),
    ).toThrow(SessionKeyPolicyViolation);
  });

  it("rejects actions outside the validAfter/validUntil window", () => {
    const policy = makePolicy({ validAfter: 1000, validUntil: 2000 });
    expect(() =>
      assertActionAllowed(
        policy,
        { target: ROUTER, selector: SWAP_SELECTOR, value: 0n },
        500,
      ),
    ).toThrow(SessionKeyPolicyViolation);
    expect(() =>
      assertActionAllowed(
        policy,
        { target: ROUTER, selector: SWAP_SELECTOR, value: 0n },
        2500,
      ),
    ).toThrow(SessionKeyPolicyViolation);
    expect(() =>
      assertActionAllowed(
        policy,
        { target: ROUTER, selector: SWAP_SELECTOR, value: 0n },
        1500,
      ),
    ).not.toThrow();
  });

  it("is case-insensitive when matching target/selector addresses", () => {
    const policy = makePolicy();
    expect(() =>
      assertActionAllowed(policy, {
        target: ROUTER.toUpperCase() as `0x${string}`,
        selector: SWAP_SELECTOR.toUpperCase() as `0x${string}`,
        value: 0n,
      }),
    ).not.toThrow();
  });
});
