#!/usr/bin/env node
/**
 * Build Android launcher icons from the official Radiant logo mark.
 *
 * Source: Radiant-Core/Radiant-Logo -> Radiant-Logo-R-Transparent.png (2500px
 * square, transparent, brand cyan + cream mark).
 *
 * This composites the images itself (crop to ink, area-average downscale,
 * centre on the target canvas) rather than shelling out to a browser: the ink
 * size is then exact and measurable instead of depending on CSS rounding, and
 * the result is deterministic.
 *
 * Outputs per density:
 *   mipmap-density/ic_launcher_foreground.png   108dp canvas, transparent
 *   mipmap-density/ic_launcher.png              48dp canvas, black bg
 *   mipmap-density/ic_launcher_round.png        48dp canvas, circular black bg
 *
 * Ink targets are measured after writing and the script fails if a result is
 * outside tolerance, so the numbers in INK are verified, not assumed.
 *
 * Usage: LOGO_SRC=path/to/mark.png node scripts/build-icons.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const RES = "android/app/src/main/res";
/**
 * The mark is vendored in the repo so `npm run icons` is reproducible on any
 * machine (source: Radiant-Core/Radiant-Logo → Radiant-Logo-R-Transparent.png).
 */
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

const load = (file) => {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { width: png.width, height: png.height, data: Buffer.from(png.data) };
};

const save = (file, img) => {
  const png = new PNG({ width: img.width, height: img.height });
  img.data.copy(png.data);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
};

/** Bounding box of pixels with meaningful alpha. */
function inkBox(img) {
  const { width, height, data } = img;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(width * y + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error("source image has no visible pixels");
  return { minX, minY, maxX, maxY };
}

function crop(img, box) {
  const w = box.maxX - box.minX + 1;
  const h = box.maxY - box.minY + 1;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((box.minY + y) * img.width + box.minX) * 4;
    img.data.copy(out, y * w * 4, from, from + w * 4);
  }
  return { width: w, height: h, data: out };
}

/** Area-average downscale, premultiplied so edges don't pick up dark fringes. */
function resizeArea(img, dw, dh) {
  const { width: sw, height: sh, data } = img;
  const out = Buffer.alloc(dw * dh * 4);
  const xScale = sw / dw;
  const yScale = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor(y * yScale);
    const sy1 = Math.min(sh, Math.max(sy0 + 1, Math.ceil((y + 1) * yScale)));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor(x * xScale);
      const sx1 = Math.min(sw, Math.max(sx0 + 1, Math.ceil((x + 1) * xScale)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sw * sy + sx) * 4;
          const al = data[i + 3];
          r += data[i] * al;
          g += data[i + 1] * al;
          b += data[i + 2] * al;
          a += al;
          n++;
        }
      }
      const o = (dw * y + x) * 4;
      if (a === 0) {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      } else {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round(a / n);
      }
    }
  }
  return { width: dw, height: dh, data: out };
}


/** Square canvas, either transparent or filled (optionally as a circle). */
function canvas(size, { bg = null, circle = false } = {}) {
  const out = Buffer.alloc(size * size * 4);
  if (bg) {
    const [r, g, b] = bg;
    const c = (size - 1) / 2;
    const radius = size / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const o = (size * y + x) * 4;
        let alpha = 1;
        if (circle) {
          const d = Math.hypot(x - c, y - c);
          // 1px soft edge so the circle mask does not alias hard.
          alpha = Math.max(0, Math.min(1, radius - d));
        }
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = Math.round(alpha * 255);
      }
    }
  }
  return { width: size, height: size, data: out };
}

/** Alpha-composite `ink` centred onto `base`. */
function blit(base, ink) {
  const { width: bw, height: bh, data: bd } = base;
  const { width: iw, height: ih, data: id } = ink;
  const ox = Math.round((bw - iw) / 2);
  const oy = Math.round((bh - ih) / 2);
  for (let y = 0; y < ih; y++) {
    const by = oy + y;
    if (by < 0 || by >= bh) continue;
    for (let x = 0; x < iw; x++) {
      const bx = ox + x;
      if (bx < 0 || bx >= bw) continue;
      const si = (iw * y + x) * 4;
      const sa = id[si + 3] / 255;
      if (sa === 0) continue;
      const di = (bw * by + bx) * 4;
      const da = bd[di + 3] / 255;
      const outA = sa + da * (1 - sa);
      if (outA === 0) continue;
      for (let c = 0; c < 3; c++) {
        const src = id[si + c];
        const dst = bd[di + c];
        bd[di + c] = Math.round((src * sa + dst * da * (1 - sa)) / outA);
      }
      bd[di + 3] = Math.round(outA * 255);
    }
  }
  return base;
}

/** Ink span as a fraction of canvas width (larger of the two axes). */
function inkFraction(img) {
  const b = inkBox(img);
  return Math.max(b.maxX - b.minX + 1, b.maxY - b.minY + 1) / img.width;
}

/**
 * Ink span for an image with an opaque background: measure pixels that differ
 * from that background instead of all opaque pixels (otherwise the whole canvas
 * counts as ink).
 */
function inkFractionVsBg(img, bg, tol = 40) {
  const { width, height, data } = img;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (width * y + x) * 4;
      if (data[i + 3] < 40) continue;
      const delta =
        Math.abs(data[i] - bg[0]) +
        Math.abs(data[i + 1] - bg[1]) +
        Math.abs(data[i + 2] - bg[2]);
      if (delta > tol) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return 0;
  return Math.max(maxX - minX + 1, maxY - minY + 1) / width;
}

// ---- build ---------------------------------------------------------------

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
  const out = blit(canvas(size, opts), scaled);
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
