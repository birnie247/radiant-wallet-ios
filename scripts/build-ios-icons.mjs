#!/usr/bin/env node
/**
 * Build the iOS app icon from the official Radiant logo mark.
 *
 * Source: assets/brand/radiant-mark.png (vendored from
 * Radiant-Core/Radiant-Logo, Apache-2.0) — brand cyan + cream, transparent.
 *
 * Outputs:
 *   assets/icon.png                                                1024x1024, opaque navy
 *   ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png  same image
 *
 * iOS app icons must be fully opaque (App Store requirement), so the mark is
 * composited onto the design system's navy canvas (radiantcore.org --bg). The
 * ink target keeps the mark comfortably inside Apple's corner-rounding mask.
 *
 * Usage: LOGO_SRC=path/to/mark.png node scripts/build-ios-icons.mjs
 */
import {
  load,
  save,
  inkBox,
  crop,
  resizeArea,
  canvas,
  blit,
  inkFractionVsBg,
} from "./lib/image.mjs";

const LOGO = process.env.LOGO_SRC ?? "assets/brand/radiant-mark.png";
/** App-icon canvas: the design system's navy (--bg), not pure black. */
const BG = [10, 14, 23];
const SIZE = 1024;
const INK = 0.62;
const TOLERANCE = 0.025;

const source = load(LOGO);
const mark = crop(source, inkBox(source));
console.log(
  `source ${source.width}x${source.height}, ink ${mark.width}x${mark.height} ` +
    `(${((mark.width / source.width) * 100).toFixed(1)}% of canvas)`,
);

const inkPx = Math.max(2, Math.round(SIZE * INK));
const scaled = resizeArea(mark, inkPx, inkPx);
const out = blit(canvas(SIZE, SIZE, { bg: BG }), scaled);

const actual = inkFractionVsBg(out, BG);
const ok = Math.abs(actual - INK) <= TOLERANCE;
console.log(`  ${ok ? "OK  " : "FAIL"} 1024x1024 ink ${Number(actual.toFixed(3))} (target ${INK})`);

const targets = [
  "assets/icon.png",
  "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png",
];
for (const file of targets) save(file, out);
console.log(`icon written to ${targets.join(" and ")}`);
if (!ok) {
  console.error("icon ink outside tolerance");
  process.exit(1);
}
