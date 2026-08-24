import { expect, test } from "bun:test";
import { prepareReleaseEnv } from "../scripts/build-macos-local";

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
