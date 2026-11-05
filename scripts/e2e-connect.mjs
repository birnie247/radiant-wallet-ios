#!/usr/bin/env node
/**
 * End-to-end: create a wallet, protect it, and watch the app connect to a
 * Radiant server and scan the chain — with a timeline, so a "stall" is
 * measurable instead of a guess.
 *
 *   npm run check:connect
 *
 * Prints every progress stage the UI shows, how long each took, and either the
 * home screen (success) or the app's error text (failure, with per-endpoint
 * reasons).
 */
import path from "node:path";
import {
  CDP,
  launchBrowser,
  sleep,
  startServer,
} from "./lib/browser-harness.mjs";

const PORT = 4192;
const DEBUG_PORT = 9223;
const PASSPHRASE = "e2e-test-passphrase-123";
const HARD_LIMIT_MS = 120_000;

const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";

const server = await startServer(PORT);
const chrome = launchBrowser({
  debugPort: DEBUG_PORT,

});

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};

try {
  const cdp = await CDP.attach(DEBUG_PORT);
  await cdp.send("Page.navigate", { url: `http://localhost:${PORT}/` });

  // 1. Fresh wallet: welcome -> create -> (seed) -> passphrase.
  if (!(await cdp.waitForSelector("#root .app", 20_000))) {
    throw new Error("app never mounted");
  }
  await cdp.clickButton("Create a new wallet");
  if (!(await cdp.waitForSelector(".seed-grid", 20_000))) {
    throw new Error("seed grid never appeared");
  }
  await cdp.eval(`document.querySelector('input[type=checkbox]')?.click()`);
  await sleep(200);
  await cdp.clickButton("Continue");
  if (!(await cdp.waitForSelector("input[type=password]", 10_000))) {
    throw new Error("passphrase step never appeared");
  }
  await cdp.fill("input[type=password]", PASSPHRASE);
  await cdp.eval(
    `(() => {
       const inputs = [...document.querySelectorAll('input[type=password]')];
       const el = inputs[1] ?? inputs[0];
       const setter = Object.getOwnPropertyDescriptor(
         HTMLInputElement.prototype, 'value').set;
       setter.call(el, ${JSON.stringify(PASSPHRASE)});
       el.dispatchEvent(new Event('input', { bubbles: true }));
       return true;
     })()`,
  );
  await sleep(150);
  if (!(await cdp.clickButton("Create wallet"))) {
    throw new Error("create-wallet button not found");
  }
  console.log(`\n=== wallet created in UI at ${at()}, connecting... ===`);

  // 2. Watch every stage the app announces until it lands or dies.
  const timeline = [];
  let lastStage = "";
  let final = null;
  while (Date.now() - t0 < HARD_LIMIT_MS) {
    const state = await cdp.eval(
      `(() => ({
         text: document.body.innerText,
         error: document.querySelector('.error')?.textContent ?? null,
       }))()`,
    );
    const text = state.text ?? "";

    // Stage detection: the app renders a Splash with its progress message.
    const stage =
      /(Connecting to [^\n]+|Scanning the blockchain[^\n]*|Reconnecting[^\n]*|Refreshing[^\n]*)/.exec(
        text,
      )?.[1] ?? "";
    if (stage && stage !== lastStage) {
      timeline.push(`${at()}  ${stage}`);
      lastStage = stage;
    }

    if (state.error) {
      final = { kind: "error", text: state.error };
      break;
    }
    if (text.includes("Receive") && text.includes("Send")) {
      final = { kind: "home", text: "" };
      break;
    }
    await sleep(300);
  }

  console.log("=== timeline ===");
  if (timeline.length === 0) console.log("  (no progress stage ever rendered)");
  for (const line of timeline) console.log("  " + line);

  if (final?.kind === "home") {
    check(`connected and scanned (finished at ${at()})`, true);
  } else if (final?.kind === "error") {
    check("connected", false, final.text.split("\n")[0]);
    console.log("\n--- full error ---");
    console.log(final.text);
  } else {
    check("finished within " + HARD_LIMIT_MS / 1000 + "s", false, "still busy");
  }

  if (cdp.console.length) {
    console.log("\n--- page console ---");
    for (const line of cdp.console.slice(-20)) console.log(line);
  }
} catch (e) {
  console.error("\nE2E FAILED:", e.message);
  failures++;
} finally {
  chrome.kill();
  server.close();
}

console.log(
  `\n${failures === 0 ? "CONNECT E2E PASSED" : failures + " CHECK(S) FAILED"}`,
);
process.exit(failures === 0 ? 0 : 1);
