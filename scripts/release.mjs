#!/usr/bin/env node
/**
 * One-command release build.
 *
 *   npm run release            # uses package.json version
 *   npm version patch && npm run release
 *
 * Steps: web build → cap sync → signed release APK → copy to dist-android/ with
 * the version in the filename → verify the signature with apksigner.
 *
 * The version lives ONLY in package.json; android/app/build.gradle derives
 * versionName from it and computes versionCode as major*10000+minor*100+patch,
 * so every release automatically has a higher versionCode than the last.
 *
 * Requirements: a keystore configured in android/keystore.properties (see
 * README). Without it Gradle produces an unsigned APK and this script fails.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = pkg.version;
const [maj, min, pat] = version.split(".").map((n) => parseInt(n, 10));
const versionCode = maj * 10000 + min * 100 + pat;

const JAVA_HOME = process.env.JAVA_HOME ?? "C:/Android/jdk21";
const ANDROID_HOME = process.env.ANDROID_HOME ?? "C:/Android/Sdk";

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

if (!existsSync(path.join(JAVA_HOME, "bin", "java.exe")) &&
    !existsSync(path.join(JAVA_HOME, "bin", "java"))) {
  fail(`JDK not found at ${JAVA_HOME}. Set JAVA_HOME to a JDK 21 install.`);
}
if (!existsSync(ANDROID_HOME)) {
  fail(`Android SDK not found at ${ANDROID_HOME}. Set ANDROID_HOME.`);
}
if (!existsSync(path.join(ROOT, "android", "keystore.properties"))) {
  fail(
    "android/keystore.properties is missing, so the APK would be unsigned.\n" +
      "  Create a keystore first — see README 'Producing a real release build'.",
  );
}

const env = { ...process.env, JAVA_HOME, ANDROID_HOME };

function run(label, cmd, args, cwd = ROOT) {
  console.log(`\n▸ ${label}`);
  try {
    execFileSync(cmd, args, { cwd, env, stdio: "inherit" });
  } catch (e) {
    console.error(`  ${e.message}`);
    fail(`${label} failed`);
  }
}

console.log(`Radiant Wallet ${version}  (versionCode ${versionCode})`);

run("building web assets", process.execPath, ["node_modules/vite/bin/vite.js", "build"]);
run("syncing Capacitor", process.execPath, [
  "node_modules/@capacitor/cli/bin/capacitor",
  "sync",
  "android",
]);

// Run Gradle through its wrapper JAR using the JDK's java binary. This avoids
// gradlew.bat/gradlew entirely, so there is no shell and no quoting hazard
// (the project path contains a space).
const javaBin = path.join(
  JAVA_HOME,
  "bin",
  process.platform === "win32" ? "java.exe" : "java",
);
const wrapperJar = path.join(ROOT, "android", "gradle", "wrapper", "gradle-wrapper.jar");
if (!existsSync(wrapperJar)) fail(`Gradle wrapper jar not found at ${wrapperJar}`);

run(
  "assembling signed release APK",
  javaBin,
  [
    "-classpath",
    wrapperJar,
    "org.gradle.wrapper.GradleWrapperMain",
    "assembleRelease",
  ],
  path.join(ROOT, "android"),
);

const built = path.join(ROOT, "android/app/build/outputs/apk/release/app-release.apk");
if (!existsSync(built)) {
  fail("no app-release.apk was produced (Gradle may have emitted app-release-unsigned.apk).");
}

const outDir = path.join(ROOT, "dist-android");
mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `radiant-wallet-${version}.apk`);
copyFileSync(built, out);
const idsig = `${built}.idsig`;
if (existsSync(idsig)) copyFileSync(idsig, `${out}.idsig`);

// Verify the signature rather than trusting the build log.
// apksigner is a .bat/.sh wrapper; run its JAR through java directly so there is
// no shell and no quoting hazard.
const buildToolsRoot = path.join(ANDROID_HOME, "build-tools");
let apksignerJar;
if (existsSync(buildToolsRoot)) {
  for (const dir of readdirSync(buildToolsRoot).sort().reverse()) {
    const candidate = path.join(buildToolsRoot, dir, "lib", "apksigner.jar");
    if (existsSync(candidate)) {
      apksignerJar = candidate;
      break;
    }
  }
}

if (!apksignerJar) {
  console.log("\n! apksigner.jar not found — skipping signature verification");
} else {
  console.log("\n▸ verifying signature");
  let report;
  try {
    report = execFileSync(
      javaBin,
      ["-jar", apksignerJar, "verify", "--print-certs", "--verbose", out],
      { env, encoding: "utf8" },
    );
  } catch (e) {
    console.error(String(e.stdout ?? "").trim());
    fail("signature verification failed — do not install this APK");
  }
  const schemes = report
    .split(/\r?\n/)
    .filter((l) => l.includes("true") && /Verified using v[\d.]+ scheme/.test(l))
    .map((l) => (l.match(/Verified using (v[\d.]+) scheme/) ?? [, "?"])[1]);
  const dn = (report.match(/certificate DN: (.+)/) ?? [, "unknown"])[1].trim();
  console.log(`  signed by : ${dn}`);
  console.log(`  schemes   : ${schemes.join(", ") || "unknown"}`);
  if (schemes.length === 0) fail("APK appears unsigned");
}

const sizeMb = (readFileSync(out).length / (1024 * 1024)).toFixed(2);
console.log(`\n✓ ${path.relative(ROOT, out)}  (${sizeMb} MB, versionCode ${versionCode})`);
console.log(`\nInstall over the existing app (keeps your wallet):`);
console.log(`  ${path.join(ANDROID_HOME, "platform-tools", "adb.exe")} install -r "${out}"`);
