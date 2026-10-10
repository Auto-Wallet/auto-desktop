import { expect, test } from "bun:test";

const manifest = await Bun.file("package.json").json();
const cargoLock = await Bun.file("src-tauri/Cargo.lock").text();
const bunLock = await Bun.file("bun.lock").text();

// Tauri checks the resolved JS/crate major and minor before any native build.
// Check all plugin pairs so a local frontend build cannot hide a release failure.
for (const name of Object.keys(manifest.dependencies)) {
  if (!name.startsWith("@tauri-apps/plugin-")) continue;
  const crate = name.replace("@tauri-apps/plugin-", "tauri-plugin-");
  test(`${name} matches the Rust plugin's major and minor release`, () => {
    const rustPackage = cargoLock.split("[[package]]").find((block) =>
      block.includes(`name = "${crate}"\n`),
    );
    if (!rustPackage) throw new Error(`Missing Rust plugin: ${crate}`);
    const rustVersion = rustPackage.match(/\nversion = "(\d+)\.(\d+)\.\d+"/);
    const jsEntry = bunLock.split("\n").find((line) => line.includes(`"${name}": ["${name}@`));
    if (!jsEntry) throw new Error(`Missing locked JS plugin: ${name}`);
    const jsVersion = jsEntry.match(/@(\d+)\.(\d+)\.\d+"/);
    if (!rustVersion || !jsVersion) throw new Error(`Invalid plugin version: ${name}`);
    expect(`${jsVersion[1]}.${jsVersion[2]}`).toBe(`${rustVersion[1]}.${rustVersion[2]}`);
  });
}
