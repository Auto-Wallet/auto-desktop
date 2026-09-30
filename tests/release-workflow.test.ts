import { expect, test } from "bun:test";

const workflow = await Bun.file(".github/workflows/release.yml").text();

function releaseStep(name: string): string {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Release step not found: ${name}`);
  const next = workflow.indexOf("\n      - name:", start + marker.length);
  return next < 0 ? workflow.slice(start) : workflow.slice(start, next);
}

const BUILD_STEPS = [
  "Build signed + notarized macOS bundles",
  "Build executable + NSIS updater installer",
];

test.each(BUILD_STEPS)("%s receives the DeBank API key", (stepName) => {
  expect(releaseStep(stepName)).toContain(
    "DEBANK_APIKEY: ${{ secrets.DEBANK_APIKEY }}",
  );
});

// Without it, `option_env!("PUBLIC_NODE_KEY")` compiles to None and every shipped
// build talks to PublicNode unauthenticated.
test.each(BUILD_STEPS)("%s receives the PublicNode RPC key", (stepName) => {
  expect(releaseStep(stepName)).toContain(
    "PUBLIC_NODE_KEY: ${{ secrets.PUBLIC_NODE_KEY }}",
  );
});

// Touch ID unlock needs the keychain entitlements, which macOS honors only with
// the Developer ID provisioning profile embedded. Both signing passes must carry
// them: `tauri build` makes the updater .app.tar.gz, the re-sign step makes the
// DMG app. Missing either one breaks Touch ID for that install path only.
test("the macOS job decodes and checks the provisioning profile before building", () => {
  const step = releaseStep("Prepare Touch ID keychain signing");
  expect(step).toContain("APPLE_PROVISIONING_PROFILE: ${{ secrets.APPLE_PROVISIONING_PROFILE }}");
  expect(step).toContain("base64 --decode");
  expect(step).toContain("bun scripts/prepare-keychain-signing.ts");
  expect(step).toContain("KEYCHAIN_BUILD_CONFIG=");
  expect(workflow.indexOf("- name: Prepare Touch ID keychain signing")).toBeLessThan(
    workflow.indexOf("- name: Build signed + notarized macOS bundles"),
  );
});

test("tauri build embeds the profile and uses the keychain entitlements", () => {
  expect(releaseStep("Build signed + notarized macOS bundles")).toContain(
    '--config "$KEYCHAIN_BUILD_CONFIG"',
  );
});

test("re-signing the DMG app keeps the keychain entitlements", () => {
  const step = releaseStep("Re-sign and repackage macOS app");
  expect(step).toContain("--entitlements src-tauri/Entitlements.keychain.plist");
  expect(step).not.toMatch(/src-tauri\/Entitlements\.plist/);
});

test("the release checks both the DMG app and the updater app for the entitlement", () => {
  const step = releaseStep("Verify macOS DMG and app notarization");
  expect(step).toContain("embedded.provisionprofile");
  expect(step).toContain("keychain-access-groups");
  expect(step).toContain(".app.tar.gz");
});
