/**
 * Shared harness for the browser-driven E2E scripts: a static server for
 * `dist/`, a headless Chromium launch, and a minimal CDP client (Node's
 * built-in WebSocket, no dependencies).
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findBrowser } from "../find-browser.mjs";

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

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Serves `dist/` (or SMOKE_DIST) on `port`. */
export async function startServer(port, dist = path.resolve(process.env.SMOKE_DIST ?? "dist")) {
  if (!existsSync(path.join(dist, "index.html"))) {
    throw new Error("dist/index.html missing — run `npm run build` first.");
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const rel = url.pathname === "/" ? "/index.html" : url.pathname;
      const full = path.join(dist, rel);
      if (!full.startsWith(dist)) return res.writeHead(403).end("forbidden");
      const data = await readFile(full);
      res.writeHead(200, {
        "content-type": MIME[path.extname(full)] ?? "application/octet-stream",
      });
      res.end(data);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((r) => server.listen(port, r));
  return server;
}

/**
 * Launches headless Chromium with a debugging port; returns the child.
 *
 * Each run gets its own throwaway profile: sharing one across runs leaves a
 * lock file behind, and a crashed run would poison the next one (a stale
 * browser can keep answering on the debugging port and hijack the session).
 */
export function launchBrowser({ debugPort, profile }) {
  const dir = profile ?? mkdtempSync(path.join(os.tmpdir(), "rxd-e2e-"));
  const child = spawn(
    findBrowser(),
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${dir}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  // Never leave an orphaned browser holding the port open.
  const kill = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  };
  process.once("exit", kill);
  process.once("SIGINT", () => {
    kill();
    process.exit(130);
  });
  return child;
}

export async function waitForChrome(debugPort, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://localhost:${debugPort}/json/list`);
      const targets = await r.json();
      const page =
        targets.find((t) => t.type === "page" && !t.url.startsWith("about:")) ??
        targets.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("Chrome debugging endpoint never came up");
}

export class CDP {
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

  static async attach(debugPort) {
    const ws = new WebSocket(await waitForChrome(debugPort));
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error("CDP connect failed"));
    });
    const cdp = new CDP(ws);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    return cdp;
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

  /** Polls `expression` until it is truthy (or the timeout elapses). */
  async waitFor(expression, timeoutMs = 15_000, stepMs = 200) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await this.eval(expression);
      if (value) return value;
      await sleep(stepMs);
    }
    return null;
  }

  waitForSelector(selector, timeoutMs = 15_000) {
    return this.waitFor(
      `!!document.querySelector(${JSON.stringify(selector)})`,
      timeoutMs,
    );
  }

  /** Clicks the first button whose text includes `text`. */
  clickButton(text) {
    return this.eval(
      `(() => {
         const b = [...document.querySelectorAll('button')]
           .find(x => x.textContent.includes(${JSON.stringify(text)}));
         if (!b) return false;
         b.click();
         return true;
       })()`,
    );
  }

  /** Types into a field the React way (native setter + input event). */
  fill(selector, value) {
    return this.eval(
      `(() => {
         const el = document.querySelector(${JSON.stringify(selector)});
         if (!el) return false;
         const proto = el instanceof HTMLTextAreaElement
           ? HTMLTextAreaElement.prototype
           : HTMLInputElement.prototype;
         const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
         setter.call(el, ${JSON.stringify(value)});
         el.dispatchEvent(new Event('input', { bubbles: true }));
         return true;
       })()`,
    );
  }

  /** The app's currently visible error, if any. */
  errorText() {
    return this.eval(`document.querySelector('.error')?.textContent ?? null`);
  }
}

