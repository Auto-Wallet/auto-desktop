import { describe, expect, test } from "bun:test";
import { keccak256, toChecksumAddress } from "./keccak";

describe("keccak256", () => {
  test("standard test vectors", () => {
    expect(keccak256("")).toBe("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(keccak256("abc")).toBe("4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
    expect(keccak256("The quick brown fox jumps over the lazy dog")).toBe(
      "4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15",
    );
  });

  test("rate-boundary and multi-block inputs (vectors from foundry `cast keccak`)", () => {
    expect(keccak256("a")).toBe("3ac225168df54212a25c1c01fd35bebfea408fdac2e31ddd6f80a4bbf9a5f1cb");
    expect(keccak256("a".repeat(135))).toBe(
      "34367dc248bbd832f4e3e69dfaac2f92638bd0bbd18f2912ba4ef454919cf446",
    );
    expect(keccak256("a".repeat(136))).toBe(
      "a6c4d403279fe3e0af03729caada8374b5ca54d8065329a3ebcaeb4b60aa386e",
    );
    expect(keccak256("a".repeat(200))).toBe(
      "96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d",
    );
  });
});

describe("toChecksumAddress", () => {
  test("reproduces the EIP-55 spec vectors from lowercase input", () => {
    expect(toChecksumAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe(
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    );
    expect(toChecksumAddress("0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359")).toBe(
      "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    );
    expect(toChecksumAddress("0xDBF03B407C01E7CD3CBEA99509D93F8DDDC8C6FB")).toBe(
      "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
    );
  });

  test("throws on non-address input instead of returning junk", () => {
    expect(() => toChecksumAddress("0x123")).toThrow();
    expect(() => toChecksumAddress("hello")).toThrow();
  });
});
