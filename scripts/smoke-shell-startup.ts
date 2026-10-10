// Run after building a debug bundle with identifier
// com.autowallet.desktop.startup-test. The probe refuses the normal wallet ID.
// bun run tauri build --debug --no-bundle --ci --config tests/fixtures/startup-smoke.conf.json
// bun scripts/smoke-shell-startup.ts src-tauri/target/debug/auto-desktop
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "darwin") throw new Error("This probe requires macOS WKWebView");
const executable = process.argv[2];
if (!executable || !existsSync(executable)) throw new Error("Pass the isolated debug app binary");
const artifacts = mkdtempSync(join(tmpdir(), "autodesktop-startup-smoke-"));
const resultPath = join(artifacts, "result.json");
const proc = Bun.spawn([resolve(executable)], {
  env: { ...process.env, AUTODESKTOP_STARTUP_SMOKE_DIR: artifacts },
  stdout: Bun.file(join(artifacts, "stdout.log")),
  stderr: Bun.file(join(artifacts, "stderr.log")),
});
try {
  const deadline = Date.now() + 15_000;
  while (!existsSync(resultPath) && Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`App exited with ${proc.exitCode}; artifacts: ${artifacts}`);
    await Bun.sleep(250);
  }
  if (!existsSync(resultPath)) throw new Error(`No native probe result; artifacts: ${artifacts}`);
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  if (result.ok !== true || result.screen !== "lock" || result.choices !== 3 || result.ipc !== true) {
    throw new Error(`Startup recovery failed: ${JSON.stringify(result)}; artifacts: ${artifacts}`);
  }
  const log = readFileSync(join(artifacts, "stdout.log"), "utf8");
  if (!log.includes("terminated provisional WebContent pid=")) throw new Error("Probe never injected the startup failure");
  console.log(`PASS: native React screen and IPC recovered after startup termination; artifacts: ${artifacts}`);
} finally {
  proc.kill();
  await proc.exited;
}
