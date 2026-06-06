// Bundles the dApp-page injection entry (src/injected/inpage.tauri.ts) plus its
// auto-wallet-core imports into a single self-contained IIFE that Rust embeds via
// include_str!(../injected/inpage.js) and injects as a webview init script.
//
// Run: bun run build:injected   (must run before `cargo build` / `tauri dev`)
import { mkdir } from 'node:fs/promises';

const OUT_DIR = 'src-tauri/injected';
const OUT_FILE = `${OUT_DIR}/inpage.js`;

await mkdir(OUT_DIR, { recursive: true });

const result = await Bun.build({
  entrypoints: ['src/injected/inpage.tauri.ts'],
  target: 'browser',
  format: 'iife',
  minify: false, // keep readable while developing
});

if (!result.success) {
  console.error('inpage injection bundle failed:');
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const code = await result.outputs[0]!.text();
await Bun.write(OUT_FILE, code);
console.log(`built ${OUT_FILE} (${code.length} bytes)`);
