# AutoDesktop icon candidates

Generated with the `ip-as-logo` workflow and Codex built-in ImageGen. The tool
accepts one prompt string, so constraints were delivered in the main prompt.

All files are native `1254 × 1254` PNGs. These are review assets and do not
replace the production icon until one is selected.

## Shared brief

- Direction: minimal guardian cat for AutoDesktop, tied to the Auto Wallet cat.
- Palette: indigo `#5B4BF0`, coral `#FF6D4D`, parchment `#F4F0E8`.
- Shape: one heavy continuous cat silhouette, two blunt rounded ears, one large
  coral face mask, two indigo eyes, and one indigo mouth.
- Finish: flat-first geometry with very low same-family tonal change, readable at
  `32 × 32`.

## Candidate map and checks

| Label | File | Prompt variation | Background | Check |
| --- | --- | --- | --- | --- |
| A1 | `auto-desktop-a1.png` | Lower-left body with a broad inward tail | Opaque | Clear at 32 px; distinct tail band and visible backdrop falloff need refinement. |
| A2 | `auto-desktop-a2.png` | Lower-right curled circular body | Opaque | Clear at 32 px; distinct tail band and visible backdrop falloff need refinement. |
| A3 | `auto-desktop-a3.png` | Front shield-like head and short chest | Opaque | Clearest simple silhouette; backdrop still has slight visible falloff. |
| A4 | `auto-desktop-a4.png` | Lower-right bean-like head and torso | Transparent | Clear at 32 px; tilted mark is not recommended. Transparency itself is allowed. |
| A5 | `auto-desktop-a5.png` | Lower-left head and broad base | Opaque | Smallest shape set; backdrop still has slight visible falloff. |
| A6 | `auto-desktop-a6.png` | Lower-right minimal head and body | Transparent | Clear at 32 px; tilted mark is not recommended. Transparency itself is allowed. |
| A5R | `auto-desktop-a5r.png` | Targeted A5 retry for a flat backdrop | Opaque | Retry kept the simple mark but did not fully remove backdrop falloff. |

## Prompt mapping

All six prompts used the shared brief above. Their controlled composition changes
are recorded in the table. A1–A3 also allowed a fused broad tail where stated;
A4–A6 explicitly removed tails and limbs. A5R repeated A5 with the backdrop as
the sole correction target.

Exact A1–A3 constraint text:

> no text, letters, numbers, watermark, border, frame, card, app-icon mask,
> scenery, extra subject, thin line, sharp tip, pointed ear, fur, whiskers, paws,
> claws, texture, glossy spot, strong 3D, photorealism, cast shadow, vignette,
> background gradient.

Exact A4–A6 constraint text:

> no text, letters, numbers, watermark, border, frame, card, app-icon mask,
> scenery, extra subject, thin line, sharp tip, pointed ear, fur, whiskers, nose,
> paws, claws, texture, gloss, strong 3D, photorealism, cast shadow, halo,
> vignette, background gradient.

Exact A5R constraint text:

> no text, letters, numbers, watermark, border, frame, card, app-icon mask,
> extra subject, scenery, thin line, sharp tip, pointed ear, separate highlights,
> gloss, strong 3D, photorealism, external shadow.
