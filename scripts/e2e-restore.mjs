#!/usr/bin/env node
/**
 * Drives the REAL built bundle in headless Chrome over CDP and exercises the
 * "Restore from recovery phrase" flow, printing console output and whatever
 * the UI shows afterwards. Debug aid for the import failure.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { findBrowser } from "./find-browser.mjs";

const DIST = path.resolve(process.env.SMOKE_DIST ?? "dist");
const PORT = 4191;
const DEBUG_PORT = 9222;
const CHROME = findBrowser();

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.console = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      } else if (msg.method === "Runtime.consoleAPICalled") {
        const text = msg.params.args
          .map((a) => a.value ?? a.description ?? a.type)
          .join(" ");
        this.console.push(`[${msg.params.type}] ${text}`);
      } else if (msg.method === "Runtime.exceptionThrown") {
        this.console.push(
          `[exception] ${msg.params.exceptionDetails.text} ${
            msg.params.exceptionDetails.exception?.description ?? ""
          }`,
        );
      }
    };
  }
  static async attach(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error("CDP connect failed"));
    });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res) => {
      this.pending.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const ex = r.result?.exceptionDetails;
    if (ex) throw new Error(`${ex.text} ${ex.exception?.description ?? ""}`);
    return r.result?.result?.value;
  }
}

if (!existsSync(path.join(DIST, "index.html"))) {
  console.error("dist/index.html missing — run `npm run build` first.");
  process.exit(1);
}


// ---------------------------------------------------------------- static server
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const full = path.join(DIST, rel);
    if (!full.startsWith(DIST)) return res.writeHead(403).end("forbidden");
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

// ---------------------------------------------------------------- chrome
const profile = path.join(process.cwd(), ".e2e-profile");
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function waitForChrome() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${DEBUG_PORT}/json/list`);
      const targets = await r.json();
      const page = targets.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("Chrome debugging endpoint never came up");
}

/** Runs the restore flow with `phrase` and reports what the UI did. */
async function runRestore(cdp, phrase, label) {
  const url = `http://localhost:${PORT}/`;
  await cdp.send("Page.navigate", { url });
  for (let i = 0; i < 40; i++) {
    const ready = await cdp.eval(
      `!!document.querySelector('#root .app') && document.readyState === 'complete'`,
    );
    if (ready) break;
    await sleep(250);
  }

  const clicked = await cdp.eval(
    `(() => {
       const b = [...document.querySelectorAll('button')]
         .find(x => x.textContent.includes('Restore from recovery phrase'));
       if (!b) return false;
       b.click();
       return true;
     })()`,
  );
  if (!clicked) throw new Error("restore button not found");
  await sleep(400);

  const filled = await cdp.eval(
    `(() => {
       const ta = document.querySelector('textarea');
       if (!ta) return false;
       const setter = Object.getOwnPropertyDescriptor(
         HTMLTextAreaElement.prototype, 'value').set;
       setter.call(ta, ${JSON.stringify(phrase)});
       ta.dispatchEvent(new Event('input', { bubbles: true }));
       return ta.value.length > 0;
     })()`,
  );
  if (!filled) throw new Error("textarea not found");

  const continued = await cdp.eval(
    `(() => {
       const b = [...document.querySelectorAll('button')]
         .find(x => x.textContent.trim() === 'Continue');
       if (!b) return false;
       b.click();
       return true;
     })()`,
  );
  if (!continued) throw new Error("continue button not found");
  await sleep(900);

  const state = await cdp.eval(
    `(() => {
       const err = document.querySelector('.error');
       const onPassphrase = !!document.querySelector('input[type=password]');
       const heading = document.querySelector('h1')?.textContent ?? '';
       return { error: err ? err.textContent : null, onPassphrase, heading,
                text: document.body.innerText.slice(0, 300) };
     })()`,
  );

  console.log(`\n=== ${label} ===`);
  console.log("heading      :", state.heading);
  console.log("error shown  :", state.error ?? "(none)");
  console.log("reached pass :", state.onPassphrase);
  return state;
}

// ---------------------------------------------------------------- test cases
const VALID_12 =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const VALID_24 =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon " +
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
const BAD_CHECKSUM =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon";
const THIRTEEN = VALID_12 + " abandon";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};

try {
  const wsUrl = await waitForChrome();
  const cdp = await CDP.attach(wsUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  const cases = [
    { phrase: VALID_12, label: "valid 12-word BIP39 vector", expectPass: true },
    { phrase: VALID_24, label: "valid 24-word BIP39 vector", expectPass: true },
    { phrase: BAD_CHECKSUM, label: "bad checksum (12x abandon)", expectPass: false },
    { phrase: THIRTEEN, label: "13 words", expectPass: false },
  ];

  for (const c of cases) {
    const state = await runRestore(cdp, c.phrase, c.label);
    if (c.expectPass) {
      check(`${c.label} -> passphrase screen`, state.onPassphrase === true);
    } else {
      check(`${c.label} -> rejected with an error`, !!state.error, state.error ?? "");
    }
  }

  if (cdp.console.length) {
    console.log("\n--- page console ---");
    for (const line of cdp.console.slice(0, 40)) console.log(line);
  } else {
    console.log("\n(page produced no console output)");
  }
} catch (e) {
  console.error("\nE2E FAILED:", e.message);
  failures++;
} finally {
  chrome.kill();
  server.close();
}

console.log(`\n${failures === 0 ? "E2E RESTORE FLOW PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);

