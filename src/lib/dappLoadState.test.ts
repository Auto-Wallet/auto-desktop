import { expect, test } from "bun:test";
import { forgetDappLoad, hasDappLoaded, markDappLoaded } from "./dappLoadState";

test("switching back to a tab that already loaded skips the loading animation", () => {
  markDappLoaded("dapp-uniswap");

  expect(hasDappLoaded("dapp-uniswap")).toBe(true);
});

test("a closed tab is forgotten, so reopening it animates again", () => {
  markDappLoaded("dapp-debank");
  markDappLoaded("dapp-aave");

  forgetDappLoad("dapp-debank");

  // Its webview was destroyed with the tab: the next open reloads the page.
  expect(hasDappLoaded("dapp-debank")).toBe(false);
  // Other tabs keep their loaded state.
  expect(hasDappLoaded("dapp-aave")).toBe(true);
});

test("a tab that never loaded animates on its first open", () => {
  expect(hasDappLoaded("dapp-never-opened")).toBe(false);
});
