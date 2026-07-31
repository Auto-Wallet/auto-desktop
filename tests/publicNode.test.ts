import { describe, expect, test } from "bun:test";
import { applyPublicNodeKey } from "../src/lib/publicNode";
import { BUILTIN_CHAINS } from "../src/lib/chains";
import { SUPPORTED_CHAINS } from "../src/lib/tokenData";

const KEY = "testkey123";

describe("PublicNode RPC key", () => {
  test("appends the key as the last path segment", () => {
    expect(applyPublicNodeKey("https://ethereum-rpc.publicnode.com", KEY)).toBe(
      "https://ethereum-rpc.publicnode.com/testkey123",
    );
    expect(applyPublicNodeKey("https://bsc-rpc.publicnode.com/", KEY)).toBe(
      "https://bsc-rpc.publicnode.com/testkey123",
    );
    expect(applyPublicNodeKey("https://publicnode.com", KEY)).toBe(
      "https://publicnode.com/testkey123",
    );
  });

  test("leaves other providers alone", () => {
    for (const url of [
      "https://rpc.soniclabs.com",
      "https://zkevm-rpc.com",
      "https://andromeda.metis.io/?owner=1088",
      "https://gwan-ssl.wandevs.org:56891",
      "https://worldchain-mainnet.g.alchemy.com/public",
    ]) {
      expect(applyPublicNodeKey(url, KEY)).toBe(url);
    }
  });

  test("matches the host, not the whole URL", () => {
    for (const url of [
      "https://evil.example/publicnode.com",
      "https://evil.example?x=publicnode.com",
      "https://notpublicnode.com",
      "https://publicnode.com.evil.example",
    ]) {
      expect(applyPublicNodeKey(url, KEY)).toBe(url);
    }
  });

  test("keeps an endpoint that already carries its own path", () => {
    expect(applyPublicNodeKey("https://ethereum-rpc.publicnode.com/otherkey", KEY)).toBe(
      "https://ethereum-rpc.publicnode.com/otherkey",
    );
  });

  test("is a no-op without a key", () => {
    expect(applyPublicNodeKey("https://ethereum-rpc.publicnode.com", "")).toBe(
      "https://ethereum-rpc.publicnode.com",
    );
  });

  // These lists are committed to git — a key baked in here would be a leak.
  test("committed chain defaults carry no key", () => {
    for (const c of [...BUILTIN_CHAINS, ...SUPPORTED_CHAINS]) {
      if (!c.rpc.includes("publicnode.com")) continue;
      const afterScheme = c.rpc.replace(/^https?:\/\//, "").replace(/\/+$/, "");
      expect(afterScheme).not.toInclude("/");
    }
  });
});
