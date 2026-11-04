#!/usr/bin/env node
/**
 * Build Android launcher icons from the official Radiant logo mark.
 *
 * Source: assets/brand/radiant-mark.png (vendored from
 * Radiant-Core/Radiant-Logo, Apache-2.0) — brand cyan + cream, transparent.
 *
 * Outputs per density (folder name in place of `density`):
 *   mipmap-density/ic_launcher_foreground.png   108dp canvas, transparent
 *   mipmap-density/ic_launcher.png              48dp canvas, black bg
 *   mipmap-density/ic_launcher_round.png        48dp canvas, circular black bg
 *
 * Ink targets are measured after writing and the script fails if a result is
 * outside tolerance, so the numbers in INK are verified, not assumed.
 *
 * Usage: LOGO_SRC=path/to/mark.png node scripts/build-icons.mjs
 */
import path from "node:path";
import {
  load,
  save,
  inkBox,
  crop,
  resizeArea,
  canvas,
  blit,
  inkFraction,
  inkFractionVsBg,
} from "./lib/image.mjs";

const RES = "android/app/src/main/res";
const LOGO = process.env.LOGO_SRC ?? "assets/brand/radiant-mark.png";

/**
 * Ink as a fraction of the canvas.
 * Android's adaptive safe zone is 66% of the 108dp canvas (72dp), so the
 * foreground mark must stay comfortably inside it; legacy icons sit tighter.
 */
const INK = { adaptive: 0.56, legacy: 0.7, round: 0.6 };

const LEGACY = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const ADAPTIVE = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };

const TOLERANCE = 0.025;

const source = load(LOGO);
const mark = crop(source, inkBox(source));
console.log(
  `source ${source.width}x${source.height}, ink ${mark.width}x${mark.height} ` +
    `(${((mark.width / source.width) * 100).toFixed(1)}% of canvas)`,
);

const results = [];
let failures = 0;

function emit(file, size, inkTarget, opts) {
  const inkPx = Math.max(2, Math.round(size * inkTarget));
  const scaled = resizeArea(mark, inkPx, inkPx);
  const out = blit(canvas(size, size, opts), scaled);
  save(file, out);
  const actual = opts.bg ? inkFractionVsBg(out, opts.bg) : inkFraction(out);
  const ok = Math.abs(actual - inkTarget) <= TOLERANCE;
  if (!ok) failures++;
  results.push({
    file: path.relative(RES, file).replace(/\\/g, "/"),
    size,
    target: inkTarget,
    actual: Number(actual.toFixed(3)),
    ok,
  });
}

for (const [density, size] of Object.entries(LEGACY)) {
  const dir = path.join(RES, `mipmap-${density}`);
  emit(path.join(dir, "ic_launcher.png"), size, INK.legacy, { bg: [0, 0, 0] });
  emit(path.join(dir, "ic_launcher_round.png"), size, INK.round, {
    bg: [0, 0, 0],
    circle: true,
  });
}

for (const [density, size] of Object.entries(ADAPTIVE)) {
  const dir = path.join(RES, `mipmap-${density}`);
  emit(path.join(dir, "ic_launcher_foreground.png"), size, INK.adaptive, {});
}

for (const r of results) {
  console.log(
    `  ${r.ok ? "OK  " : "FAIL"} ${r.file.padEnd(46)} ${String(r.size).padStart(3)}px  ink ${r.actual} (target ${r.target})`,
  );
}

console.log(`\n${results.length} icons written to ${RES}`);
if (failures > 0) {
  console.error(`${failures} icon(s) outside ink tolerance`);
  process.exit(1);
}
