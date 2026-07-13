import { describe, expect, test } from "bun:test";
import type { XfQuote } from "../xflows";
import { NATIVE_TOKEN_ADDRESS, type QuoteParams } from "./types";
import { toNeutralQuote } from "./xflows-provider";

const params: QuoteParams = {
  fromChainId: 42161,
  toChainId: 888,
  fromToken: {
    chainId: 42161,
    address: NATIVE_TOKEN_ADDRESS,
    symbol: "ETH",
    name: "Ether",
    decimals: 18,
    logo: "",
  },
  toToken: {
    chainId: 888,
    address: NATIVE_TOKEN_ADDRESS,
    symbol: "WAN",
    name: "Wanchain",
    decimals: 18,
    logo: "",
  },
  fromAddress: "0x2fb4D46372Ea1748ec3c29Bd2C7B536019DF5200",
  toAddress: "0x2fb4D46372Ea1748ec3c29Bd2C7B536019DF5200",
  fromAmount: "0.1",
  slippage: 0.01,
};

describe("XFlows fee classification", () => {
  test("distinguishes the cross-chain message fee from the bridge network fee", () => {
    const quote: XfQuote = {
      amountOut: "3330.497592464035",
      amountOutRaw: "3330497592464035000000",
      amountOutMin: "3297.1926165393943",
      amountOutMinRaw: "3297192616539394300000",
      slippage: 0.01,
      priceImpact: -0.0892,
      workMode: 3,
      bridge: "wanbridge",
      dex: "wanchain",
      nativeFees: [
        { nativeFeeAmount: "134864000000", nativeFeeSymbol: "ETH", nativeFeeDecimals: 18 },
        { nativeFeeAmount: "12000000000000", nativeFeeSymbol: "ETH", nativeFeeDecimals: 18 },
      ],
      tokenFees: [],
      extraData: {
        dex: {
          params: {
            messageFee: "134864000000",
            networkFee0: "12000000000000",
          },
          fees: { networkFee: "12000000000000" },
        },
      },
    };

    expect(toNeutralQuote(quote, params).fees).toEqual([
      { kind: "message", amount: "0.00000013", symbol: "ETH" },
      { kind: "network", amount: "0.000012", symbol: "ETH" },
    ]);
  });
});
