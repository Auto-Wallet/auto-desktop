#!/usr/bin/env bun

// Usage: APPLE_TEAM_ID=<team> bun scripts/prepare-keychain-signing.ts <profile.provisionprofile>
//
// Used by the release workflow before `tauri build`. Checks that the Developer ID
// provisioning profile matches this app (team, app id, keychain group, expiry),
// then prints the `tauri build --config` JSON that embeds it and signs with
// src-tauri/Entitlements.keychain.plist. Prints nothing on stdout on failure.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  checkProvisioningProfile,
  keychainConfig,
  readProvisioningProfile,
} from "./build-macos-local";

async function main(): Promise<void> {
  const [profileArg] = process.argv.slice(2);
  if (!profileArg) {
    throw new Error(
      "Usage: APPLE_TEAM_ID=<team> bun scripts/prepare-keychain-signing.ts <profile.provisionprofile>",
    );
  }
  const teamId = process.env.APPLE_TEAM_ID?.trim();
  if (!teamId) throw new Error("Missing APPLE_TEAM_ID");

  const root = resolve(import.meta.dir, "..");
  const profilePath = resolve(profileArg);
  if (!existsSync(profilePath)) throw new Error(`Provisioning profile not found: ${profilePath}`);
  const config = await Bun.file(join(root, "src-tauri/tauri.conf.json")).json();

  checkProvisioningProfile(await readProvisioningProfile(profilePath), {
    teamId,
    bundleId: String(config.identifier),
    now: new Date(),
  });
  const entitlements = join(root, "src-tauri/Entitlements.keychain.plist");
  console.log(JSON.stringify(keychainConfig(profilePath, entitlements)));
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
