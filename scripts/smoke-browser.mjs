#!/usr/bin/env node
/**
 * Browser smoke test — the gate that Node-based tests cannot provide.
 *
 * Builds nothing itself; it serves `dist/` and loads the REAL built bundle in
 * headless Chrome, then asserts the app actually mounted.
 *
 * This exists because the Node test suite gave a false pass: `Buffer` is a Node
 * global, so a bundle that referenced a bare `Buffer` threw
 * `ReferenceError: Buffer is not defined` only in a browser/WebView and shipped
 * as a black screen. Anything that must run in a WebView gets checked here.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const DIST = path.resolve(process.env.SMOKE_DIST ?? "dist");
const PORT = 4189;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

function findBrowser() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "No Chrome/Edge found. Set CHROME_PATH to a Chromium-based browser.",
  );
}

function runBrowser(browser, url) {
  return new Promise((resolve, reject) => {
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--no-first-run",
      "--disable-extensions",
      `--user-data-dir=${path.join(process.cwd(), ".smoke-profile")}`,
      "--virtual-time-budget=15000",
      "--dump-dom",
      url,
    ];
    execFile(browser, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

if (!existsSync(path.join(DIST, "index.html"))) {
  console.error("dist/index.html missing — run `npm run build` first.");
  process.exit(1);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const full = path.join(DIST, rel);
    if (!full.startsWith(DIST)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const data = await readFile(full);
    res.writeHead(200, {
      "content-type": MIME[path.extname(full)] ?? "application/octet-stream",
    });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
});

await new Promise((r) => server.listen(PORT, r));

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  OK  " : "  FAIL"} ${label}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};

try {
  const browser = findBrowser();
  console.log(`Using ${path.basename(browser)}`);
  const dom = await runBrowser(browser, `http://localhost:${PORT}/`);

  const crashed =
    /Uncaught\s+\w*Error/.test(dom) ||
    /ReferenceError:/.test(dom) ||
    /TypeError:/.test(dom);

  check("app shell mounted (#root has .app)", dom.includes('<div class="app"'));
  check("onboarding UI rendered", dom.includes("Create a new wallet"));
  check("no uncaught error in the page", !crashed);

  if (crashed || !dom.includes("Create a new wallet")) {
    const start = dom.indexOf("<div id=\"root\">");
    console.error("\n--- rendered root ---\n" + dom.slice(start, start + 1200));
  }
} catch (e) {
  check("smoke run", false, e.message);
} finally {
  server.close();
}

console.log(
  `\n${failures === 0 ? "BROWSER SMOKE TEST PASSED" : failures + " SMOKE CHECK(S) FAILED"}`,
);
process.exit(failures === 0 ? 0 : 1);
