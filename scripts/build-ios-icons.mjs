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

// ---------------------------------------------------------------- in-app logo
// The mark for the app's own brand tile (splash, welcome, unlock, home). Cut to
// its ink box and scaled up so it stays crisp at 3x on a 30–64px tile.
const WEB_INK = 256;
save("src/assets/radiant-mark.png", resizeArea(mark, WEB_INK, WEB_INK));
console.log(`in-app mark written to src/assets/radiant-mark.png (${WEB_INK}px, transparent)`);

// ---------------------------------------------------------------- launch screen
// The Capacitor template ships a white splash image, which flashes the screen
// white before a dark app appears. Repaint it as the navy canvas with the mark
// centred, so the launch screen matches the app's first frame.
const SPLASH = 2732;
const SPLASH_INK = 0.22;
const splashInkPx = Math.round(SPLASH * SPLASH_INK);
const splash = blit(
  canvas(SPLASH, SPLASH, { bg: BG }),
  resizeArea(mark, splashInkPx, splashInkPx),
);
const splashFiles = [
  "splash-2732x2732.png",
  "splash-2732x2732-1.png",
  "splash-2732x2732-2.png",
];
for (const name of splashFiles) {
  save(`ios/App/App/Assets.xcassets/Splash.imageset/${name}`, splash);
}
console.log(`launch screen written to Splash.imageset (${SPLASH}px, ink ${SPLASH_INK})`);

