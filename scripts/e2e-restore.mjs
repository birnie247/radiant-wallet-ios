#!/usr/bin/env node
/**
 * Drives the REAL built bundle in headless Chromium and exercises the
 * "Restore from recovery phrase" flow with the standard BIP39 vectors.
 *
 *   npm run check:restore
 *
 * Valid phrases must reach the passphrase step; a bad checksum and a wrong
 * word count must be rejected with the UI's own messages.
 */
import { CDP, launchBrowser, sleep, startServer } from "./lib/browser-harness.mjs";

const PORT = 4191;
const DEBUG_PORT = 9222;

const VALID_12 =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const VALID_24 =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon " +
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
const BAD_CHECKSUM =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon";
const THIRTEEN = VALID_12 + " abandon";

const server = await startServer(PORT);
const chrome = launchBrowser({ debugPort: DEBUG_PORT });

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};

/** Runs the restore flow with `phrase` and reports what the UI did. */
async function runRestore(cdp, phrase, label) {
  await cdp.send("Page.navigate", { url: `http://localhost:${PORT}/` });
  await cdp.waitForSelector("#root .app", 20_000);

  if (!(await cdp.clickButton("Restore from recovery phrase"))) {
    throw new Error("restore button not found");
  }
  if (!(await cdp.waitForSelector("textarea", 5_000))) {
    throw new Error("textarea not found");
  }
  await cdp.fill("textarea", phrase);
  await sleep(150);
  if (!(await cdp.clickButton("Continue"))) {
    throw new Error("continue button not found");
  }
  await sleep(900);

  const state = await cdp.eval(
    `(() => ({
       error: document.querySelector('.error')?.textContent ?? null,
       onPassphrase: !!document.querySelector('input[type=password]'),
       heading: document.querySelector('h1')?.textContent ?? '',
     }))()`,
  );

  console.log(`\n=== ${label} ===`);
  console.log("heading      :", state.heading);
  console.log("error shown  :", state.error ?? "(none)");
  console.log("reached pass :", state.onPassphrase);
  return state;
}

try {
  const cdp = await CDP.attach(DEBUG_PORT);

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
  }
} catch (e) {
  console.error("\nE2E FAILED:", e.message);
  failures++;
} finally {
  chrome.kill();
  server.close();
}

console.log(
  `\n${failures === 0 ? "E2E RESTORE FLOW PASSED" : failures + " CHECK(S) FAILED"}`,
);
process.exit(failures === 0 ? 0 : 1);
