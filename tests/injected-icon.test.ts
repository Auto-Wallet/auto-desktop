import { expect, test } from "bun:test";
import { bundleInjected } from "../scripts/build-injected";

// dApps list wallets by the EIP-6963 `info.icon` the injected script announces.
// It must be the AutoDesktop icon (a square PNG ≥ 96px, per EIP-6963), not the
// blue "A" placeholder.
test("the injected provider announces the AutoDesktop PNG icon", async () => {
  const code = await bundleInjected();
  const uri = code.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/)?.[0];
  if (!uri) throw new Error("no PNG data URI in the injected bundle");

  const png = Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
  expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
  // IHDR: width at byte 16, height at byte 20.
  expect(png.readUInt32BE(16)).toBe(96);
  expect(png.readUInt32BE(20)).toBe(96);
});
