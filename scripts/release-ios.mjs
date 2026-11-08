#!/usr/bin/env node
/**
 * One-command release archive.
 *
 *   npm run release
 *
 * Steps: web build → cap sync → xcodebuild archive (Release) → export to
 * dist-ios/ with the version in the filename.
 *
 * The version lives ONLY in package.json; the build number is derived from it
 * (major*10000 + minor*100 + patch) and passed to xcodebuild, so every release
 * automatically has a higher build number than the last.
 *
 * Signing: the archive is built UNSIGNED so it can be produced on any Mac
 * (or in CI) without certificates. To actually ship:
 *   - simplest: open ios/App/App.xcodeproj in Xcode, pick your team, Run; or
 *   - set RADIOANT_EXPORT_OPTIONS=/path/exportOptions.plist — a standard
 *     Xcode export plist (method app-store / ad-hoc / enterprise, with your
 *     signing entries) — and this script exports a signed .ipa instead of
 *     the unsigned package.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = pkg.version;
const [maj, min, pat] = version.split(".").map((n) => parseInt(n, 10));
const buildNumber = maj * 10000 + min * 100 + pat;

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function run(label, cmd, args, cwd = ROOT) {
  console.log(`\n▸ ${label}`);
  try {
    execFileSync(cmd, args, { cwd, stdio: "inherit" });
  } catch (e) {
    fail(`${label} failed`);
  }
}

try {
  execFileSync("xcodebuild", ["-version"], { stdio: "ignore" });
} catch {
  fail("xcodebuild not found — the release step requires a Mac with Xcode.");
}

console.log(`Lumen RXD Wallet ${version}  (build ${buildNumber})`);

run("building web assets", process.execPath, ["node_modules/vite/bin/vite.js", "build"]);
run("syncing Capacitor", process.execPath, [
  "node_modules/@capacitor/cli/bin/capacitor",
  "sync",
  "ios",
]);

const appDir = path.join(ROOT, "ios", "App");
const archivePath = path.join(appDir, "build", `RadiantWallet-${version}.xcarchive`);
run(
  "archiving (Release, unsigned — sign on export or in Xcode)",
  "xcodebuild",
  [
    "-project", "App.xcodeproj",
    "-scheme", "App",
    "-configuration", "Release",
    "-destination", "generic/platform=iOS",
    "-archivePath", archivePath,
    `-MARKETING_VERSION=${version}`,
    `-CURRENT_PROJECT_VERSION=${buildNumber}`,
    "CODE_SIGNING_ALLOWED=NO",
    "CODE_SIGNING_REQUIRED=NO",
    "archive",
  ],
  appDir,
);
if (!existsSync(archivePath)) fail("no xcarchive was produced");

const outDir = path.join(ROOT, "dist-ios");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const outBase = path.join(outDir, `radiant-wallet-${version}`);

// Default: the "package" export method — an unsigned .ipa in a .pkg that can
// be resigned later. With RADIOANT_EXPORT_OPTIONS set, use the owner's export
// plist instead (app-store / ad-hoc / enterprise).
const exportPlist = process.env.RADIOANT_EXPORT_OPTIONS;
if (exportPlist) {
  run(
    "exporting signed ipa",
    "xcodebuild",
    [
      "-exportArchive",
      "-archivePath", archivePath,
      "-exportOptionsPlist", path.resolve(exportPlist),
      "-outputPath", outBase,
    ],
  );
} else {
  const opts = path.join(outDir, "exportOptions.plist");
  writeFileSync(
    opts,
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      '<plist version="1.0"><dict>\n' +
      '  <key>method</key><string>package</string>\n' +
      "</dict></plist>\n",
  );
  run(
    "exporting unsigned package (resign before distributing)",
    "xcodebuild",
    [
      "-exportArchive",
      "-archivePath", archivePath,
      "-exportOptionsPlist", opts,
      "-outputPath", outBase,
    ],
  );
}

console.log(`\n✓ output in ${path.relative(ROOT, outDir)}/`);
console.log(
  "Next: sign (Xcode → your team, or RADIOANT_EXPORT_OPTIONS with a signed " +
    "exportOptions.plist) and install.",
);
