import { expect, test } from "bun:test";
import {
  buildConfigOverride,
  checkProvisioningProfile,
  prepareReleaseEnv,
} from "../scripts/build-macos-local";

test("local macOS release accepts the documented DeBank key alias", () => {
  const env = prepareReleaseEnv({
    APPLE_ID: "builder@example.com",
    APPLE_PASSWORD: "app-password",
    APPLE_TEAM_ID: "TEAM123",
    DEBANK_API_KEY: "debank-test-key",
  });

  expect(env.DEBANK_APIKEY).toBe("debank-test-key");
  expect(env.DEBANK_API_KEY).toBe("debank-test-key");
});

test("local macOS release refuses to build without notarization credentials", () => {
  expect(() =>
    prepareReleaseEnv({
      DEBANK_APIKEY: "debank-test-key",
    }),
  ).toThrow("Missing release environment: APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID");
});

test("local macOS release refuses to build without a DeBank key", () => {
  expect(() =>
    prepareReleaseEnv({
      APPLE_ID: "builder@example.com",
      APPLE_PASSWORD: "app-password",
      APPLE_TEAM_ID: "TEAM123",
    }),
  ).toThrow("Missing release environment: DEBANK_APIKEY or DEBANK_API_KEY");
});

// A decoded Developer ID profile (only the fields the check reads).
const profile = (over: Record<string, unknown> = {}) => ({
  TeamIdentifier: ["9V2W2U87ZG"],
  ExpirationDate: new Date("2031-01-01T00:00:00Z").toISOString(),
  Entitlements: {
    "com.apple.application-identifier": "9V2W2U87ZG.com.autowallet.desktop",
    "keychain-access-groups": ["9V2W2U87ZG.*"],
  },
  ...over,
});
const want = {
  teamId: "9V2W2U87ZG",
  bundleId: "com.autowallet.desktop",
  now: new Date("2026-09-28T00:00:00Z"),
};

test("a matching, unexpired Developer ID profile passes", () => {
  expect(() => checkProvisioningProfile(profile(), want)).not.toThrow();
});

test("a profile for another app, team, or already expired is refused", () => {
  expect(() =>
    checkProvisioningProfile(
      profile({ Entitlements: { "com.apple.application-identifier": "9V2W2U87ZG.com.other.app", "keychain-access-groups": ["9V2W2U87ZG.*"] } }),
      want,
    ),
  ).toThrow("com.other.app");
  expect(() => checkProvisioningProfile(profile({ TeamIdentifier: ["OTHERTEAM1"] }), want)).toThrow(
    "OTHERTEAM1",
  );
  expect(() =>
    checkProvisioningProfile(profile({ ExpirationDate: "2026-01-01T00:00:00Z" }), want),
  ).toThrow("expired");
});

test("a profile without the keychain access group is refused", () => {
  expect(() =>
    checkProvisioningProfile(
      profile({ Entitlements: { "com.apple.application-identifier": "9V2W2U87ZG.com.autowallet.desktop" } }),
      want,
    ),
  ).toThrow("keychain-access-groups");
});

test("the build override embeds the profile and switches to keychain entitlements", () => {
  const override = JSON.parse(
    buildConfigOverride("/abs/app.provisionprofile", "/abs/Entitlements.keychain.plist"),
  );
  expect(override).toEqual({
    bundle: {
      createUpdaterArtifacts: false,
      macOS: {
        entitlements: "/abs/Entitlements.keychain.plist",
        files: { "embedded.provisionprofile": "/abs/app.provisionprofile" },
      },
    },
  });
});
