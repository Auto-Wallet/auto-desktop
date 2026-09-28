#!/usr/bin/env bun

// Usage: bun run build:macos:local
//
// Bun loads the ignored .env.local before this script starts. The DeBank key is
// deliberately compiled into the app, so anyone who receives the app may be
// able to extract it. This script never prints key values, but it does upload
// the compiled app and DMG to Apple's notarization service.

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

type ReleaseEnvSource = Record<string, string | undefined>;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function prepareReleaseEnv(source: ReleaseEnvSource): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] =>
      Boolean(nonEmpty(entry[1])),
    ),
  );
  const missing: string[] = [];
  for (const name of ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"]) {
    if (!nonEmpty(env[name])) missing.push(name);
  }

  const debankKey = nonEmpty(env.DEBANK_APIKEY) ?? nonEmpty(env.DEBANK_API_KEY);
  if (!debankKey) missing.push("DEBANK_APIKEY or DEBANK_API_KEY");
  if (missing.length > 0) {
    throw new Error(`Missing release environment: ${missing.join(", ")}`);
  }

  env.DEBANK_APIKEY = debankKey!;
  env.DEBANK_API_KEY = debankKey!;
  const zerionKey = nonEmpty(env.ZERION_APIKEY) ?? nonEmpty(env.ZERION_API_KEY);
  if (zerionKey) {
    env.ZERION_APIKEY = zerionKey;
    env.ZERION_API_KEY = zerionKey;
  }
  return env;
}

/** The fields of a decoded provisioning profile the release check relies on. */
export type ProvisioningProfile = {
  TeamIdentifier?: unknown;
  ExpirationDate?: unknown;
  Entitlements?: Record<string, unknown>;
};

/**
 * Touch ID unlock keeps the vault password in the data-protection keychain,
 * which needs `keychain-access-groups` — a restricted entitlement macOS honors
 * only with a matching provisioning profile embedded in the app. A wrong,
 * expired, or incomplete profile does not fail the build: it produces an app
 * macOS refuses to launch. So check it before spending a build on it.
 */
export function checkProvisioningProfile(
  profile: ProvisioningProfile,
  want: { teamId: string; bundleId: string; now: Date },
): void {
  const teams = Array.isArray(profile.TeamIdentifier) ? profile.TeamIdentifier : [];
  if (!teams.includes(want.teamId)) {
    throw new Error(
      `Provisioning profile is for team ${teams.join(", ") || "(none)"}, not ${want.teamId}`,
    );
  }
  const entitlements = profile.Entitlements ?? {};
  const appId = entitlements["com.apple.application-identifier"];
  const wantAppId = `${want.teamId}.${want.bundleId}`;
  if (appId !== wantAppId) {
    throw new Error(`Provisioning profile is for ${String(appId)}, not ${wantAppId}`);
  }
  const groups = entitlements["keychain-access-groups"];
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error("Provisioning profile does not grant keychain-access-groups");
  }
  const expires = new Date(String(profile.ExpirationDate));
  if (Number.isNaN(expires.getTime())) {
    throw new Error(`Provisioning profile has no readable ExpirationDate`);
  }
  if (expires <= want.now) {
    throw new Error(`Provisioning profile expired on ${expires.toISOString()}`);
  }
}

/** `tauri build --config` override for the signed local release. */
export function buildConfigOverride(profilePath: string, entitlementsPath: string): string {
  return JSON.stringify({
    bundle: {
      createUpdaterArtifacts: false,
      macOS: {
        entitlements: entitlementsPath,
        files: { "embedded.provisionprofile": profilePath },
      },
    },
  });
}

async function output(command: string[], stdin?: string): Promise<string> {
  const child = Bun.spawn(command, {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [text, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${command.join(" ")} failed (${code}): ${err.trim()}`);
  }
  return text;
}

/** Decode a .provisionprofile (CMS-signed plist) into JSON. */
export async function readProvisioningProfile(path: string): Promise<ProvisioningProfile> {
  const xml = await output(["security", "cms", "-D", "-i", path]);
  // plutil's JSON writer rejects <date> and <data>; the check needs only the
  // date's text, and none of the <data> blobs (certificates).
  const jsonSafe = xml
    .replace(/<date>([^<]*)<\/date>/g, "<string>$1</string>")
    .replace(/<data>[^<]*<\/data>/g, "<string></string>");
  return JSON.parse(await output(["plutil", "-convert", "json", "-o", "-", "-"], jsonSafe));
}

async function run(
  label: string,
  command: string[],
  env: Record<string, string>,
): Promise<void> {
  console.log(`\n==> ${label}`);
  const child = Bun.spawn(command, {
    cwd: resolve("."),
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${exitCode}`);
  }
}

function newestDmg(directory: string, version: string): string {
  const prefix = `AutoDesktop_${version}_`;
  const matches = readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".dmg"))
    .map((name) => join(directory, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  if (!matches[0]) {
    throw new Error(`No ${prefix}*.dmg found in ${directory}`);
  }
  return matches[0];
}

async function binaryContains(binaryPath: string, secret: string): Promise<boolean> {
  const binary = Buffer.from(await Bun.file(binaryPath).arrayBuffer());
  return binary.includes(Buffer.from(secret));
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("This release script runs only on macOS");
  }

  const root = resolve(import.meta.dir, "..");
  process.chdir(root);
  const env = prepareReleaseEnv(process.env);
  const config = await Bun.file(join(root, "src-tauri/tauri.conf.json")).json();
  const version = String(config.version);
  const profilePath = nonEmpty(env.APPLE_PROVISIONING_PROFILE);
  if (!profilePath) {
    throw new Error(
      "Missing release environment: APPLE_PROVISIONING_PROFILE (path to the Developer ID .provisionprofile)",
    );
  }
  const absoluteProfile = resolve(profilePath);
  if (!existsSync(absoluteProfile)) {
    throw new Error(`Provisioning profile not found: ${absoluteProfile}`);
  }
  checkProvisioningProfile(await readProvisioningProfile(absoluteProfile), {
    teamId: env.APPLE_TEAM_ID,
    bundleId: String(config.identifier),
    now: new Date(),
  });
  console.log("Provisioning profile check=OK");
  const keychainEntitlements = join(root, "src-tauri/Entitlements.keychain.plist");
  const appPath = join(
    root,
    "src-tauri/target/release/bundle/macos/AutoDesktop.app",
  );
  const binaryPath = join(appPath, "Contents/MacOS/auto-desktop");
  const dmgDir = join(root, "src-tauri/target/release/bundle/dmg");

  console.log(`AutoDesktop local macOS release v${version}`);
  for (const name of [
    "DEBANK_APIKEY",
    "ZERION_API_KEY",
    "PUBLIC_NODE_KEY",
    "SAFE_API_KEY",
  ]) {
    console.log(`${name}=${nonEmpty(env[name]) ? "SET" : "UNSET"}`);
  }
  console.log("Updater artifacts=DISABLED (the installed app still checks updates)");

  await run(
    "Check Developer ID signing identity",
    ["security", "find-identity", "-v", "-p", "codesigning"],
    env,
  );
  await run(
    "Clear the app release output so compile-time keys cannot stay stale",
    [
      "cargo",
      "clean",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "-p",
      "auto-desktop",
      "--release",
    ],
    env,
  );
  await run(
    "Build, sign, notarize, and staple the app bundle",
    [
      "bun",
      "run",
      "tauri",
      "build",
      "--bundles",
      "app,dmg",
      "--config",
      buildConfigOverride(absoluteProfile, keychainEntitlements),
    ],
    env,
  );

  if (!existsSync(binaryPath)) {
    throw new Error(`Built app binary not found: ${binaryPath}`);
  }
  if (!(await binaryContains(binaryPath, env.DEBANK_APIKEY))) {
    throw new Error("The built app does not contain the configured DeBank key");
  }
  console.log("DeBank compile-time key check=OK (value not printed)");

  if (!existsSync(join(appPath, "Contents/embedded.provisionprofile"))) {
    throw new Error("The built app has no embedded.provisionprofile");
  }
  const signedEntitlements = await output([
    "codesign",
    "-d",
    "--entitlements",
    ":-",
    appPath,
  ]);
  if (!signedEntitlements.includes("keychain-access-groups")) {
    throw new Error("The built app is not signed with keychain-access-groups");
  }
  console.log("Keychain entitlement + embedded profile check=OK");

  const dmgPath = newestDmg(dmgDir, version);
  await run(
    "Submit the signed DMG to Apple notarization",
    [
      "xcrun",
      "notarytool",
      "submit",
      dmgPath,
      "--apple-id",
      env.APPLE_ID,
      "--password",
      env.APPLE_PASSWORD,
      "--team-id",
      env.APPLE_TEAM_ID,
      "--wait",
    ],
    env,
  );
  await run(
    "Staple the DMG notarization ticket",
    ["xcrun", "stapler", "staple", dmgPath],
    env,
  );

  await run(
    "Verify the app code signature",
    ["codesign", "--verify", "--deep", "--strict", "--verbose=4", appPath],
    env,
  );
  await run(
    "Ask Gatekeeper to assess the app",
    ["spctl", "--assess", "--type", "execute", "--verbose=4", appPath],
    env,
  );
  await run(
    "Validate the app notarization ticket",
    ["xcrun", "stapler", "validate", appPath],
    env,
  );
  await run(
    "Verify the DMG code signature",
    ["codesign", "--verify", "--strict", "--verbose=4", dmgPath],
    env,
  );
  await run(
    "Ask Gatekeeper to assess the DMG",
    [
      "spctl",
      "--assess",
      "--type",
      "open",
      "--context",
      "context:primary-signature",
      "--verbose=4",
      dmgPath,
    ],
    env,
  );
  await run(
    "Validate the DMG notarization ticket",
    ["xcrun", "stapler", "validate", dmgPath],
    env,
  );

  const mountDir = mkdtempSync(join(tmpdir(), "autodesktop-dmg-verify-"));
  let mounted = false;
  try {
    await run(
      "Mount the final DMG read-only",
      ["hdiutil", "attach", dmgPath, "-readonly", "-nobrowse", "-mountpoint", mountDir],
      env,
    );
    mounted = true;
    const packagedApp = join(mountDir, "AutoDesktop.app");
    await run(
      "Verify the app inside the final DMG",
      ["codesign", "--verify", "--deep", "--strict", "--verbose=4", packagedApp],
      env,
    );
    await run(
      "Ask Gatekeeper to assess the app inside the final DMG",
      ["spctl", "--assess", "--type", "execute", "--verbose=4", packagedApp],
      env,
    );
  } finally {
    if (mounted) {
      await run("Detach the verification DMG", ["hdiutil", "detach", mountDir], env);
    }
    rmSync(mountDir, { recursive: true, force: true });
  }

  console.log("\nRelease complete");
  console.log(`DMG: ${dmgPath}`);
  console.log(`File: ${basename(dmgPath)}`);
  console.log(`SHA-256: ${await sha256(dmgPath)}`);
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
