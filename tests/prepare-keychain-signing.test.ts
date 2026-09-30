import { expect, test } from "bun:test";
import { keychainConfig } from "../scripts/build-macos-local";

test("the keychain config only switches entitlements and embeds the profile", () => {
  // CI keeps the updater artifacts on; only the local build turns them off.
  expect(keychainConfig("/tmp/p.provisionprofile", "/repo/src-tauri/Entitlements.keychain.plist")).toEqual({
    bundle: {
      macOS: {
        entitlements: "/repo/src-tauri/Entitlements.keychain.plist",
        files: { "embedded.provisionprofile": "/tmp/p.provisionprofile" },
      },
    },
  });
});

test("the CLI refuses to run without a profile path", async () => {
  const child = Bun.spawn(["bun", "scripts/prepare-keychain-signing.ts"], {
    env: { ...process.env, APPLE_TEAM_ID: "9V2W2U87ZG" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).not.toBe(0);
  expect(out).toBe("");
  expect(err).toContain("Usage");
});
