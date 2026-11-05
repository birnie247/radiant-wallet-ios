#!/usr/bin/env node
/**
 * Offline recovery-phrase checker.
 *
 * Reads a BIP39 phrase from stdin and validates it locally. Nothing is sent
 * anywhere: no network calls, no files written, and the report never repeats
 * the phrase or its words — only positions, counts and typo suggestions.
 *
 *   node scripts/check-phrase.mjs          # type/paste it, press Enter
 *   pbpaste | node scripts/check-phrase.mjs  # or pipe it in
 *
 * It answers the question the app's error message leaves open:
 *   - is the word count one of 12 / 15 / 18 / 21 / 24?
 *   - is every word actually in the BIP39 English word list?
 *   - does the checksum match? (one wrong word breaks it)
 */
import { createHash } from "node:crypto";
import wordlist from "@radiant-core/radiantjs/lib/mnemonic/words/english.js";

const VALID_COUNTS = [12, 15, 18, 21, 24];

/** Levenshtein distance, for "did you mean" suggestions. */
function distance(a, b) {
  if (a === b) return 0;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return prev[b.length];
}

function suggest(word) {
  const hits = [];
  for (const candidate of wordlist) {
    const d = distance(word, candidate);
    if (d <= 2) hits.push([d, candidate]);
  }
  return hits
    .sort((x, y) => x[0] - y[0])
    .slice(0, 3)
    .map(([, w]) => w);
}

/** BIP39 checksum: the last bits of the entropy hash must match the phrase. */
function checksumOk(words) {
  const bits = words
    .map((w) => wordlist.indexOf(w).toString(2).padStart(11, "0"))
    .join("");
  const csLen = bits.length - (bits.length * 32) / 33;
  const entropyBits = bits.slice(0, bits.length - csLen);
  const entropy = Buffer.alloc(entropyBits.length / 8);
  for (let i = 0; i < entropy.length; i++) {
    entropy[i] = parseInt(entropyBits.slice(i * 8, i * 8 + 8), 2);
  }
  const hashBits = [...createHash("sha256").update(entropy).digest()]
    .map((b) => b.toString(2).padStart(8, "0"))
    .join("");
  return bits.slice(bits.length - csLen) === hashBits.slice(0, csLen);
}

/** Reads the phrase without echoing it (raw mode); falls back to a pipe. */
async function readHidden(prompt) {
  if (!process.stdin.isTTY) {
    let buf = "";
    for await (const chunk of process.stdin) buf += chunk;
    return buf;
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

const phrase = await readHidden(
  "Recovery phrase (typing is hidden, press Enter when done):\n> ",
);
const words = phrase.trim().toLowerCase().split(/\s+/).filter(Boolean);

console.log("");
if (words.length === 0) {
  console.log("No phrase entered.");
  process.exit(1);
}

let ok = true;

// 1. Word count
const countOk = VALID_COUNTS.includes(words.length);
if (countOk) {
  console.log(`  OK    word count: ${words.length}`);
} else {
  ok = false;
  console.log(`  FAIL  word count: ${words.length} (need 12, 15, 18, 21 or 24)`);
}

// 2. Every word present in the BIP39 list
const unknown = [];
words.forEach((w, i) => {
  if (!wordlist.includes(w)) unknown.push({ position: i + 1, word: w });
});
if (unknown.length === 0) {
  console.log("  OK    all words are in the BIP39 English list");
} else {
  ok = false;
  console.log(`  FAIL  ${unknown.length} word(s) not in the BIP39 list:`);
  for (const u of unknown) {
    const hints = suggest(u.word);
    console.log(
      `          position ${u.position}` +
        (hints.length ? ` — did you mean: ${hints.join(", ")}?` : ""),
    );
  }
}

// 3. Checksum (only meaningful when everything above passed)
if (countOk && unknown.length === 0) {
  if (checksumOk(words)) {
    console.log("  OK    checksum matches");
  } else {
    ok = false;
    console.log(
      "  FAIL  checksum does not match — one word is wrong or the order is off",
    );
  }
}

// 4. Paste artefacts worth knowing about
const duplicates = words.filter((w, i) => words.indexOf(w) !== i);
if (duplicates.length) {
  console.log(
    `  NOTE  repeated word(s): ${[...new Set(duplicates)].join(", ")} (may be legitimate, may be a paste glitch)`,
  );
}

console.log("");
console.log(
  ok
    ? "  VERDICT: valid BIP39 phrase — the app accepts this."
    : "  VERDICT: the app will reject this phrase (see the failures above).",
);
process.exit(ok ? 0 : 1);

