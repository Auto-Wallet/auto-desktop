// CI smoke runner: launches the built app with AUTODESKTOP_SMOKE_DIR set, waits
// for src-tauri/src/smoke.rs to report through the real injected-provider
// pipeline, screenshots the desktop while the app is still up (the screenshots
// are the "what does it actually look like on Windows" artifact), then asserts
// the result.
//
// Usage: bun scripts/smoke-ci.ts <path-to-app-binary>
// Artifacts land in ./smoke-artifacts (result JSON, screenshots, app logs).

import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';

const exe = process.argv[2];
if (!exe || !existsSync(exe)) {
  console.error(`usage: bun scripts/smoke-ci.ts <path-to-app-binary> (got: ${exe})`);
  process.exit(2);
}

const outDir = resolve('smoke-artifacts');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const proc = Bun.spawn([resolve(exe)], {
  env: { ...process.env, AUTODESKTOP_SMOKE_DIR: outDir },
  stdout: Bun.file(join(outDir, 'app-stdout.log')),
  stderr: Bun.file(join(outDir, 'app-stderr.log')),
});

async function screenshot(file: string) {
  if (process.platform === 'win32') {
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      'Add-Type -AssemblyName System.Drawing;',
      '$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen;',
      '$bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height;',
      '$g = [System.Drawing.Graphics]::FromImage($bmp);',
      '$g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size);',
      `$bmp.Save('${file.replaceAll('\\', '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png);`,
    ].join(' ');
    await Bun.spawn(['powershell', '-NoProfile', '-Command', ps]).exited;
  } else if (process.platform === 'darwin') {
    await Bun.spawn(['screencapture', '-x', file]).exited;
  }
  console.log(existsSync(file) ? `screenshot: ${file}` : `screenshot FAILED: ${file}`);
}

const resultPath = join(outDir, 'smoke-result.json');
const deadline = Date.now() + 120_000;
while (!existsSync(resultPath) && Date.now() < deadline) {
  if (proc.exitCode !== null) {
    console.error(`smoke FAILED: app exited early with code ${proc.exitCode}`);
    await screenshot(join(outDir, 'desktop-app-exited.png'));
    process.exit(1);
  }
  await Bun.sleep(1000);
}

// Give the page a beat to render its own ok/fail line, then capture.
await Bun.sleep(2000);
await screenshot(join(outDir, 'desktop.png'));
proc.kill();

if (!existsSync(resultPath)) {
  console.error('smoke FAILED: timed out after 120s waiting for smoke-result.json');
  console.error('(the dapp webview never loaded the page, or the provider never answered)');
  process.exit(1);
}

const result = JSON.parse(readFileSync(resultPath, 'utf8'));
console.log('smoke result:', JSON.stringify(result));
if (result.ok !== true) {
  console.error(`smoke FAILED: ${result.error}`);
  process.exit(1);
}
if (typeof result.chainId !== 'string' || !/^0x[0-9a-f]+$/i.test(result.chainId)) {
  console.error(`smoke FAILED: eth_chainId returned ${JSON.stringify(result.chainId)}`);
  process.exit(1);
}
console.log(`smoke OK: provider answered through the real webview pipeline (chainId=${result.chainId})`);
