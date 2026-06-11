// EXPERIMENTAL — UI-level E2E through tauri-driver (the official Tauri
// WebDriver path). tauri-driver supports Windows + Linux only, never macOS
// (Apple ships no WKWebView WebDriver), so this suite runs exclusively in the
// `e2e-windows-experimental` CI job (manual workflow_dispatch, non-blocking).
//
// Prereqs on the runner: `cargo install tauri-driver`, a debug build of the
// app, and msedgedriver (GitHub Windows runners preinstall it and export
// EDGEWEBDRIVER pointing at its directory).

import { spawn } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appBinary = resolve(
  here,
  '../../src-tauri/target/debug',
  process.platform === 'win32' ? 'auto-desktop.exe' : 'auto-desktop',
);

let tauriDriver;

export const config = {
  hostname: '127.0.0.1',
  port: 4444,
  specs: ['./test/**/*.spec.js'],
  maxInstances: 1,
  capabilities: [
    {
      maxInstances: 1,
      'tauri:options': { application: appBinary },
    },
  ],
  reporters: ['spec'],
  framework: 'mocha',
  mochaOpts: { ui: 'bdd', timeout: 120000 },
  waitforTimeout: 15000,
  connectionRetryTimeout: 120000,

  onPrepare: () => {
    const args = [];
    if (process.env.EDGEWEBDRIVER) {
      args.push('--native-driver', join(process.env.EDGEWEBDRIVER, 'msedgedriver.exe'));
    }
    tauriDriver = spawn('tauri-driver', args, {
      stdio: [null, process.stdout, process.stderr],
    });
    tauriDriver.on('error', (e) => {
      console.error('tauri-driver failed to start (is it cargo-installed?):', e);
      process.exit(1);
    });
  },

  onComplete: () => {
    if (tauriDriver) tauriDriver.kill();
  },
};
