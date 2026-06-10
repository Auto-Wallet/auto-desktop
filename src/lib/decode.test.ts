import { describe, expect, test } from "bun:test";
import {
  MAX_UINT160,
  MAX_UINT256,
  chainIdToHex,
  detectPermit,
  encodeErc20Approve,
  parseApprovalDetails,
  parseTransferDetails,
} from "./decode";

const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // USDC
const SPENDER = "0x1111111254eeb25477b68fb85ed929f73a960582";
const RECIPIENT = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const OWNER = "0xab5801a7d398351b8be11c439e05c5b3259aec9b";

const pad = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

describe("parseTransferDetails", () => {
  test("decodes transfer(address,uint256) — recipient and amount, not the token contract", () => {
    const amount = 1_234_567n; // 1.234567 USDC (6 decimals)
    const tx = { to: TOKEN, data: `0xa9059cbb${pad(RECIPIENT)}${pad(`0x${amount.toString(16)}`)}` };
    const d = parseTransferDetails(tx);
    expect(d).not.toBeNull();
    expect(d!.tokenAddress).toBe(TOKEN);
    expect(d!.recipient.toLowerCase()).toBe(RECIPIENT.toLowerCase());
    expect(d!.owner).toBeNull();
    expect(d!.amountRaw).toBe(amount);
  });

  test("decodes transferFrom(address,address,uint256) including the owner", () => {
    const amount = 99_000_000_000_000_000_000n; // 99 tokens at 18 decimals
    const tx = {
      to: TOKEN,
      data: `0x23b872dd${pad(OWNER)}${pad(RECIPIENT)}${pad(`0x${amount.toString(16)}`)}`,
    };
    const d = parseTransferDetails(tx);
    expect(d!.owner!.toLowerCase()).toBe(OWNER.toLowerCase());
    expect(d!.recipient.toLowerCase()).toBe(RECIPIENT.toLowerCase());
    expect(d!.amountRaw).toBe(amount);
  });

  test("returns null for other selectors and truncated calldata", () => {
    expect(parseTransferDetails({ to: TOKEN, data: `0x095ea7b3${pad(SPENDER)}${pad("0x1")}` })).toBeNull();
    expect(parseTransferDetails({ to: TOKEN, data: `0xa9059cbb${pad(RECIPIENT)}` })).toBeNull();
    expect(parseTransferDetails({ to: TOKEN, data: "0x" })).toBeNull();
    expect(parseTransferDetails({ to: "", data: `0xa9059cbb${pad(RECIPIENT)}${pad("0x1")}` })).toBeNull();
  });
});

describe("parseApprovalDetails / encodeErc20Approve", () => {
  test("decode → re-encode round-trips exactly", () => {
    const amount = 500_000_000n; // 500 USDC
    const data = encodeErc20Approve(SPENDER, amount);
    const d = parseApprovalDetails({ to: TOKEN, data });
    expect(d!.spender.toLowerCase()).toBe(SPENDER.toLowerCase());
    expect(d!.amountRaw).toBe(amount);
    expect(encodeErc20Approve(d!.spender, d!.amountRaw)).toBe(data);
  });
});

describe("detectPermit", () => {
  test("ERC-2612 permit: spender, value, deadline, token = verifyingContract", () => {
    const deadline = 1_780_000_000n;
    const p = detectPermit({
      domain: { name: "USD Coin", chainId: 1, verifyingContract: TOKEN },
      primaryType: "Permit",
      message: {
        owner: OWNER,
        spender: SPENDER,
        value: "250000000",
        nonce: 0,
        deadline: deadline.toString(),
      },
    });
    expect(p).not.toBeNull();
    expect(p!.spender).toBe(SPENDER);
    expect(p!.token).toBe(TOKEN);
    expect(p!.amountRaw).toBe(250_000_000n);
    expect(p!.unlimited).toBe(false);
    expect(p!.deadline).toBe(deadline);
    expect(p!.chainHex).toBe("0x1");
  });

  test("flags max-uint256 allowance as unlimited", () => {
    const p = detectPermit({
      domain: { name: "Token", chainId: 1, verifyingContract: TOKEN },
      primaryType: "Permit",
      message: { owner: OWNER, spender: SPENDER, value: MAX_UINT256.toString(), deadline: "1" },
    });
    expect(p!.unlimited).toBe(true);
  });

  test("DAI-style permit (allowed: true) is unlimited with no numeric amount", () => {
    const p = detectPermit({
      domain: { name: "Dai Stablecoin", chainId: 1, verifyingContract: TOKEN },
      primaryType: "Permit",
      message: { holder: OWNER, spender: SPENDER, nonce: 1, expiry: 0, allowed: true },
    });
    expect(p!.unlimited).toBe(true);
    expect(p!.amountRaw).toBeNull();
  });

  test("Permit2 PermitSingle: token/amount/expiration come from details", () => {
    const p = detectPermit({
      domain: { name: "Permit2", chainId: 137, verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
      primaryType: "PermitSingle",
      message: {
        details: { token: TOKEN, amount: MAX_UINT160.toString(), expiration: "1893456000", nonce: 0 },
        spender: SPENDER,
        sigDeadline: "1780001234",
      },
    });
    expect(p!.token).toBe(TOKEN);
    expect(p!.spender).toBe(SPENDER);
    expect(p!.unlimited).toBe(true); // max uint160 = Permit2 "infinite"
    expect(p!.deadline).toBe(1_780_001_234n);
    expect(p!.chainHex).toBe("0x89");
  });

  test("Permit2 PermitBatch: first details entry is surfaced", () => {
    const p = detectPermit({
      domain: { name: "Permit2", chainId: 1 },
      primaryType: "PermitBatch",
      message: {
        details: [{ token: TOKEN, amount: "777", expiration: "1700000000", nonce: 0 }],
        spender: SPENDER,
        sigDeadline: "1700000600",
      },
    });
    expect(p!.token).toBe(TOKEN);
    expect(p!.amountRaw).toBe(777n);
  });

  test("non-permit typed data (EIP-712 Mail) is NOT flagged", () => {
    const p = detectPermit({
      domain: { name: "Ether Mail", chainId: 1, verifyingContract: TOKEN },
      primaryType: "Mail",
      message: { from: { name: "Cow" }, to: { name: "Bob" }, contents: "Hello, Bob!" },
    });
    expect(p).toBeNull();
  });

  test("junk values from a malicious dApp do not throw", () => {
    const p = detectPermit({
      domain: { chainId: "not-a-number" },
      primaryType: "Permit",
      message: { spender: SPENDER, value: "0xzz", deadline: {} },
    });
    expect(p).not.toBeNull(); // primaryType says Permit → still warn
    expect(p!.amountRaw).toBeNull();
    expect(p!.deadline).toBeNull();
    expect(p!.chainHex).toBeNull();
  });
});

describe("chainIdToHex", () => {
  test("accepts number, decimal string, and hex string", () => {
    expect(chainIdToHex(1)).toBe("0x1");
    expect(chainIdToHex("137")).toBe("0x89");
    expect(chainIdToHex("0x38")).toBe("0x38");
    expect(chainIdToHex("garbage")).toBeNull();
    expect(chainIdToHex(0)).toBeNull();
  });
});
