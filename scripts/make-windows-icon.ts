// Regenerate src-tauri/icons/icon.ico from icons/icon.png with rounded corners
// baked into every size. Windows renders the .ico verbatim (taskbar, desktop,
// installer) — there is no OS-side corner masking like the macOS dock look, so
// the rounding must live in the asset. Radius is 22% of the edge, approximating
// the macOS squircle proportion so both platforms read as the same icon.
//
// Requires ImageMagick (`magick`) for resize + mask; the ICO container itself is
// assembled here so every entry stays PNG-compressed (scripts/check-icons.ts
// rejects BMP entries, which is what ImageMagick would write for small sizes).
//
// Run: bun scripts/make-windows-icon.ts && bun scripts/check-icons.ts

import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ICONS_DIR = join(import.meta.dir, '..', 'src-tauri', 'icons');
const SOURCE = join(ICONS_DIR, 'icon.png');
const OUT = join(ICONS_DIR, 'icon.ico');
// Same size set the previous (tauri-icon generated) icon.ico carried.
const SIZES = [256, 64, 48, 32, 24, 16];
const RADIUS_RATIO = 0.22;

const work = mkdtempSync(join(tmpdir(), 'autodesktop-ico-'));
try {
  const pngs: Buffer[] = [];
  for (const size of SIZES) {
    const radius = Math.max(2, Math.round(size * RADIUS_RATIO));
    const out = join(work, `icon-${size}.png`);
    const proc = Bun.spawnSync(
      [
        'magick',
        SOURCE,
        '-resize',
        `${size}x${size}`,
        '(',
        '-size',
        `${size}x${size}`,
        'xc:none',
        '-draw',
        `roundrectangle 0,0,${size - 1},${size - 1},${radius},${radius}`,
        ')',
        '-compose',
        'DstIn',
        '-composite',
        `PNG32:${out}`,
      ],
      { stderr: 'pipe' },
    );
    if (proc.exitCode !== 0) {
      throw new Error(`magick failed for ${size}px: ${proc.stderr.toString()}`);
    }
    pngs.push(Buffer.from(await Bun.file(out).arrayBuffer()));
  }

  // ICO container: ICONDIR (6 bytes) + ICONDIRENTRY (16 bytes each) + images.
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(SIZES.length, 4);

  const dir = Buffer.alloc(16 * SIZES.length);
  let offset = 6 + dir.length;
  SIZES.forEach((size, i) => {
    const base = i * 16;
    dir.writeUInt8(size === 256 ? 0 : size, base); // width (0 = 256)
    dir.writeUInt8(size === 256 ? 0 : size, base + 1); // height
    dir.writeUInt8(0, base + 2); // palette
    dir.writeUInt8(0, base + 3); // reserved
    dir.writeUInt16LE(1, base + 4); // color planes
    dir.writeUInt16LE(32, base + 6); // bits per pixel
    dir.writeUInt32LE(pngs[i].length, base + 8);
    dir.writeUInt32LE(offset, base + 12);
    offset += pngs[i].length;
  });

  await Bun.write(OUT, Buffer.concat([header, dir, ...pngs]));
  console.log(`wrote ${OUT}: ${SIZES.map((s) => `${s}px`).join(', ')} (rounded, PNG entries)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
