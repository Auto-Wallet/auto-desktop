// Bundles the dApp-page injection entry (src/injected/inpage.tauri.ts) plus its
// wallet-core imports into a single self-contained IIFE that Rust embeds via
// include_str!(../injected/inpage.js) and injects as a webview init script.
//
// Run: bun run build:injected   (must run before `cargo build` / `tauri dev`)
import { mkdir, readFile } from 'node:fs/promises';

const OUT_DIR = 'src-tauri/injected';
const OUT_FILE = `${OUT_DIR}/inpage.js`;
const ICON_FILE = 'src/injected/auto-wallet-icon.png';

/** Build the IIFE and return its source. */
export async function bundleInjected(): Promise<string> {
  // The EIP-6963 wallet icon travels inside the script as a data URI: the page
  // gets no URL to fetch. Read here and passed via `define` because Bun
  // 1.3.13's `.png` dataurl/base64 loaders emit an empty string.
  const icon = `data:image/png;base64,${(await readFile(ICON_FILE)).toString('base64')}`;
  const result = await Bun.build({
    entrypoints: ['src/injected/inpage.tauri.ts'],
    target: 'browser',
    format: 'iife',
    minify: false, // keep readable while developing
    define: { __AUTO_WALLET_ICON__: JSON.stringify(icon) },
  });

  if (!result.success) {
    throw new Error(
      `inpage injection bundle failed:\n${result.logs.map(String).join('\n')}`,
    );
  }
  return result.outputs[0]!.text();
}

if (import.meta.main) {
  await mkdir(OUT_DIR, { recursive: true });
  const code = await bundleInjected();
  await Bun.write(OUT_FILE, code);
  console.log(`built ${OUT_FILE} (${code.length} bytes)`);
}
