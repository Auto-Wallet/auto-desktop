import { describe, expect, test } from "bun:test";
import { fmtAmount, fmtTiny, fmtUnitsDisplay, fmtUsd, formatUnits, isAddress } from "./format";

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

describe("fmtAmount (numbers never ellipsize)", () => {
  test("compacts from 1M up so the value stays readable on a narrow card", () => {
    expect(fmtAmount("8722104611.7831")).toBe("8.72B");
    expect(fmtAmount("2500000")).toBe("2.5M");
    expect(fmtAmount("1000000")).toBe("1M");
  });

  test("keeps 6 significant digits below 1M, with separators", () => {
    expect(fmtAmount("25755.2778")).toBe("25,755.3");
    expect(fmtAmount("999999.1234")).toBe("999,999");
    expect(fmtAmount("17.1858")).toBe("17.1858");
    expect(fmtAmount("0.0624")).toBe("0.0624");
    expect(fmtAmount("0.5265384377")).toBe("0.526538");
    expect(fmtAmount("33.6505536007")).toBe("33.6506");
  });

  test("passes through non-numeric input untouched", () => {
    expect(fmtAmount("")).toBe("");
    expect(fmtAmount("n/a")).toBe("n/a");
  });
});

describe("fmtTiny (subscript dust notation)", () => {
  test("renders leading-zero counts as subscripts", () => {
    expect(fmtTiny(0.0000123)).toBe("0.0₄123");
    expect(fmtTiny(0.000099)).toBe("0.0₄99");
    expect(fmtTiny(0.00000015)).toBe("0.0₆15");
  });

  test("keeps up to 4 significant digits, trims trailing zeros", () => {
    expect(fmtTiny(0.000012345678)).toBe("0.0₄1235");
    expect(fmtTiny(0.00001000)).toBe("0.0₄1");
  });

  test("rounding up to 10 shifts one zero away", () => {
    expect(fmtTiny(0.000099996)).toBe("0.0₃1");
  });

  test("returns null outside the dust range", () => {
    expect(fmtTiny(0)).toBeNull();
    expect(fmtTiny(0.0001)).toBeNull();
    expect(fmtTiny(1.5)).toBeNull();
  });
});

describe("tiny values surface as subscripts across formatters", () => {
  test("fmtUsd", () => {
    expect(fmtUsd(0.0000123)).toBe("$0.0₄123");
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(1234.5)).toBe("$1,234.50");
  });

  test("fmtAmount", () => {
    expect(fmtAmount("0.00001234")).toBe("0.0₄1234");
    expect(fmtAmount("0.0624")).toBe("0.0624");
  });

  test("fmtUnitsDisplay", () => {
    expect(fmtUnitsDisplay("12300000000000", 18)).toBe("0.0₄123");
    expect(fmtUnitsDisplay("62400000000000000", 18)).toBe("0.0624");
    expect(fmtUnitsDisplay("0", 18)).toBe("0");
    // Real balances must round to 6 significant digits, never print 10+ decimals.
    expect(fmtUnitsDisplay("33650553600700000000", 18)).toBe("33.6506");
    expect(fmtUnitsDisplay("109623448800000000", 18)).toBe("0.109623");
    expect(fmtUnitsDisplay("526538437700000000", 18)).toBe("0.526538");
  });
});
