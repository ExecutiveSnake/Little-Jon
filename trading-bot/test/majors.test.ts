import { describe, expect, it } from "vitest";
import { majorFromKey, majorKey, majorToken, lookupMajor, MAJORS } from "../src/tokens/majors.js";
import { tokenStorageKey } from "../src/tokens/registry.js";
import { getChainDef, listChains } from "../src/chain/chains.js";

describe("majors", () => {
  it("resolves major symbols case-insensitively", () => {
    expect(lookupMajor("sol")).toBe("SOL");
    expect(lookupMajor(" eth ")).toBe("ETH");
    expect(lookupMajor("NOTACOIN")).toBeNull();
  });

  it("builds chain-independent storage keys for majors", () => {
    const onSolana = majorToken("SOL", "solana");
    const onEthereum = majorToken("SOL", "ethereum");
    expect(onSolana.key).toBe("major:SOL");
    expect(onEthereum.key).toBe(onSolana.key); // shared candles/oracle price
    expect(onSolana.chain).toBe("solana");
    expect(onEthereum.chain).toBe("ethereum");
    expect(onSolana.kind).toBe("major");
  });

  it("round-trips major keys", () => {
    const token = majorFromKey(majorKey("btc"), "robinhood");
    expect(token?.symbol).toBe("BTC");
    expect(token?.pythFeedId).toBe(MAJORS.BTC!.pythFeedId);
    expect(majorFromKey("0xdeadbeef", "robinhood")).toBeUndefined();
  });
});

describe("chain registry", () => {
  it("namespaces non-home-chain token keys", () => {
    expect(tokenStorageKey("robinhood", "0xAB")).toBe("0xab");
    expect(tokenStorageKey("ethereum", "0xAB")).toBe("ethereum:0xab");
  });

  it("exposes the three chains with correct capabilities", () => {
    const ids = listChains().map((c) => c.id);
    expect(ids).toEqual(["robinhood", "ethereum", "solana"]);
    expect(getChainDef("ethereum").univ2Router).toMatch(/^0x/);
    expect(getChainDef("ethereum").wrappedMajors.ETH).toBeDefined();
    expect(getChainDef("solana").canExecute).toBe(false);
    expect(() => getChainDef("dogechain")).toThrow(/unknown or disabled/);
  });
});
