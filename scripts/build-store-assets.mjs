#!/usr/bin/env node
/**
 * Build the Google Play store graphics.
 *
 * Play requires:
 *   • App icon      512×512, 32-bit PNG
 *   • Feature graphic  1024×500  PNG/JPEG
 *   • Phone screenshots (2–8) — captured from the running app, see README
 *
 * The icon is composited with the same verified maths as the launcher icons
 * (scripts/lib/image.mjs). The feature graphic needs real type, so it is
 * rendered by headless Chrome from an HTML template that embeds the vendored
 * Inter font and the logo — no design-tool round trip, and reproducible.
 *
 * Usage: node scripts/build-store-assets.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { PNG } from "pngjs";
import { load, save, inkBox, crop, resizeArea, canvas, blit } from "./lib/image.mjs";

const LOGO = process.env.LOGO_SRC ?? "assets/brand/radiant-mark.png";
const FONT = "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2";
const OUT = path.resolve(process.env.STORE_OUT ?? "play/store");

const ICON_SIZE = 512;
const FEATURE = { width: 1024, height: 500 };

const CHROME = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => p && existsSync(p));

const dataUri = (file, mime) =>
  `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;

// ---- app icon ------------------------------------------------------------

const source = load(LOGO);
const mark = crop(source, inkBox(source));
// Play icons are shown as a full square, so the mark can be larger than on a
// launcher icon where the OS applies its own mask.
const iconInk = 0.72;
const inkPx = Math.round(ICON_SIZE * iconInk);
const icon = blit(
  canvas(ICON_SIZE, ICON_SIZE, { bg: [0, 0, 0] }),
  resizeArea(mark, inkPx, inkPx),
);
save(path.join(OUT, "icon-512.png"), icon);
console.log(`icon-512.png  ${ICON_SIZE}x${ICON_SIZE}  mark at ${iconInk * 100}%`);

// ---- feature graphic -----------------------------------------------------

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face{font-family:InterV;font-weight:100 900;font-style:normal;
    src:url(${dataUri(FONT, "font/woff2")}) format("woff2-variations");}
  html,body{margin:0;width:${FEATURE.width}px;height:${FEATURE.height}px;overflow:hidden;background:#000}
  .wrap{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:52px;
    background:radial-gradient(760px 420px at 24% 50%, rgba(0,168,224,0.22), transparent 62%);}
  img{width:188px;height:188px;flex:0 0 auto}
  .eyebrow{font-family:InterV;font-weight:600;font-size:15px;letter-spacing:.24em;
    text-transform:uppercase;color:#00A8E0}
  h1{margin:12px 0 10px;font-family:InterV;font-weight:750;font-size:60px;line-height:1.04;
    letter-spacing:-.02em;color:#FAFAFF}
  p{margin:0;font-family:InterV;font-weight:400;font-size:21px;line-height:1.35;color:#898E94}
</style></head><body><div class="wrap">
  <img src="${dataUri(LOGO, "image/png")}">
  <div>
    <div class="eyebrow">Radiant &middot; RXD</div>
    <h1>Radiant Wallet</h1>
    <p>Non-custodial. Your keys never leave the device.</p>
  </div>
</div></body></html>`;

fs.mkdirSync(OUT, { recursive: true });
const FEATURE_FILE = path.join(OUT, "feature-graphic-1024x500.png");

/**
 * Render the HTML to PNG.
 *
 * Chrome's --screenshot is flaky here: it can exit 0 without writing a file,
 * especially with a relative output path (its CWD after forking is not
 * guaranteed). So the path is absolute and each attempt is verified, retried
 * up to three times.
 */
async function renderFeature(attempt = 1) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const page = path.join(os.tmpdir(), `rxd-feature-${stamp}.html`);
  const profile = path.join(os.tmpdir(), `rxd-chrome-${stamp}`);
  fs.writeFileSync(page, html);
  fs.rmSync(FEATURE_FILE, { force: true });

  await new Promise((resolve, reject) => {
    execFile(
      CHROME,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        "--allow-file-access-from-files",
        "--force-device-scale-factor=1",
        `--user-data-dir=${profile}`,
        `--window-size=${FEATURE.width},${FEATURE.height}`,
        "--virtual-time-budget=6000",
        `--screenshot=${FEATURE_FILE}`,
        "file:///" + page.replace(/\\/g, "/"),
      ],
      (err) => {
        fs.rmSync(page, { force: true });
        fs.rmSync(profile, { recursive: true, force: true });
        err ? reject(err) : resolve();
      },
    );
  });

  if (!fs.existsSync(FEATURE_FILE)) {
    if (attempt >= 3) throw new Error("Chrome did not produce the feature graphic");
    console.warn(`  retrying feature graphic (attempt ${attempt + 1})`);
    return renderFeature(attempt + 1);
  }
}

await renderFeature();

// Assert the feature graphic is the exact size Play demands.
const feature = PNG.sync.read(fs.readFileSync(FEATURE_FILE));
if (feature.width !== FEATURE.width || feature.height !== FEATURE.height) {
  throw new Error(
    `feature graphic is ${feature.width}x${feature.height}, expected ${FEATURE.width}x${FEATURE.height}`,
  );
}

const iconPng = PNG.sync.read(fs.readFileSync(path.join(OUT, "icon-512.png")));
console.log(
  `feature-graphic-1024x500.png  ${feature.width}x${feature.height}\n` +
    `icon check: ${iconPng.width}x${iconPng.height}`,
);
console.log(`\nstore assets written to ${OUT}`);
