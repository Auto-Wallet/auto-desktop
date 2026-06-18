import { describe, expect, test } from "bun:test";
import { formatUnits, isAddress } from "./format";

describe("isAddress (EIP-55)", () => {
  test("accepts correctly checksummed mixed-case addresses (EIP-55 spec vectors)", () => {
    expect(isAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toBe(true);
    expect(isAddress("0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359")).toBe(true);
    expect(isAddress("0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB")).toBe(true);
    expect(isAddress("0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb")).toBe(true);
  });

  test("accepts all-lowercase / all-uppercase (no checksum information)", () => {
    expect(isAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe(true);
    expect(isAddress("0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED")).toBe(true);
  });

  test("REJECTS mixed-case addresses with a broken checksum (mangled paste)", () => {
    // First spec vector with one letter's case flipped (a→A in "aAeb").
    expect(isAddress("0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toBe(false);
    // Last char case flipped (d→D).
    expect(isAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD")).toBe(false);
  });

  test("still rejects malformed shapes", () => {
    expect(isAddress("0x123")).toBe(false);
    expect(isAddress("5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toBe(false);
    expect(isAddress("0xZZZeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toBe(false);
  });
});

describe("formatUnits", () => {
  test("keeps wei-sized gas fees visible when formatting as Gwei", () => {
    expect(formatUnits("0x3", 9, 9)).toBe("0.000000003");
  });
});
