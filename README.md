# Radiant Wallet — non-custodial RXD for Android

A self-custody wallet for the [Radiant](https://radiantblockchain.org) (RXD)
blockchain. Your recovery phrase is generated on the device, encrypted on the
device, and used to sign transactions on the device. No server ever sees a
private key.

Built with **React + TypeScript + Capacitor**, signing through
[`@radiant-core/sdk`](https://www.npmjs.com/package/@radiant-core/sdk) — the
same library that powers Photonic Wallet — so Radiant-specific consensus
behaviour is the ecosystem's own proven code rather than a re-implementation.

---

## What works today

| Flow | Status |
| --- | --- |
| Create wallet (BIP39 12-word) with encrypted backup | ✅ verified |
| Restore from 12/15/18/21/24-word phrase (checksum validated) | ✅ verified |
| Encrypted seed at rest (AES-256-GCM, PBKDF2-SHA256 600k, 12-char min) | ✅ implemented |
| BIP44 discovery, gap limit 20, receive + change chains | ✅ verified |
| Live balance / UTXO fetch over ElectrumX WebSocket | ✅ verified vs mainnet |
| Ref-safe send with review screen | ✅ signing verified offline |
| Broadcast | ⚠️ implemented, not exercised with real funds |
| Mainnet / testnet, server switch with failover | ✅ implemented |
| Reveal recovery phrase behind passphrase re-entry | ✅ implemented |
| Auto-lock after 60 s in background | ✅ implemented |
| QR code display for receiving | ✅ implemented |
| Transaction history with confirmation counts | ✅ verified against synthetic txs |
| Biometric unlock (Android Keystore + BiometricPrompt) | ✅ compiles into APK; not device-run |
| Recovery phrase blocks screenshots & screen recording | ✅ compiles into APK; not device-run |
| **QR scanning, Glyph tokens, WAVE names, price** | ❌ not yet |

> **Honest caveat:** no transaction has been broadcast to mainnet from this code
> by me, because that requires funds. Everything up to and including a valid
> signature is verified. Treat the first real send as a test: start small.

---

## Radiant-specific facts (verified, not assumed)

Checked against the live chain, Radiant Core constants and the production
Photonic Wallet config. Getting any of them wrong produces a wallet that
silently derives the wrong addresses or burns tokens.

| Parameter | Value |
| --- | --- |
| Address format | Base58 only — P2PKH `0x00` (`1…`), P2SH `0x05` (`3…`). **No SegWit/bech32** |
| HD path | `m/44'/512'/account'/change/index` (SLIP-0044 coin type **512**) |
| Base unit | 1 RXD = **100,000,000 photons** |
| Signing | `SIGHASH_ALL \| FORKID` = `0x41` |
| Chain access | ElectrumX over **WebSocket**: `electrumx.radiant4people.com:50022` |
| Node P2P port | 7333 |

### The two places a naive wallet loses money

**1. Ref outputs (`OP_PUSHINPUTREF`, opcodes `0xD0–0xD8`).** A UTXO holding a
Glyph FT/NFT carries a ref *inside its output script*. It looks like ordinary
spendable value, so a value-based coin selector will spend it as fee funding —
and **burn the token**. Every funding path here goes through the SDK's
`selectRxdFunding`, which screens candidates by both indexer-reported refs and a
local opcode scan, and throws `TokenBurnGuardError` rather than risk a burn.

These are *not* a mandatory trailing output: a plain P2PKH payment legitimately
has no ref output. An earlier assumption during development that they were was
wrong, and the live build disproved it.

**2. Signing key order.** `buildTx` selects the signing key by **input index**
(`privKeys[index]`), not by matching the address. Spend inputs from several
addresses and the WIF array must stay exactly parallel to the inputs array, or
you get valid-looking transactions with invalid signatures. `buildPayment`
builds both in a single pass so they cannot drift, and
`scripts/check-multisign.mjs` proves the behaviour against the real signer.

### Dead servers (do not reintroduce)

The endpoints published in `@radiant-core/constants` are stale — both
`electrum.radiant.ovh` and `electrum.radiantblockchain.org` **no longer resolve
in DNS**, and `electrumx.radiantcore.org` accepts TCP but never completes a TLS
handshake. `src/lib/servers.ts` uses Photonic's production list instead. Run
`npm run probe` to re-check which endpoints are alive.

---

## Architecture

```
src/
  lib/
    wallet.ts     HD discovery, balance aggregation, ref-safe payment building
    vault.ts      AES-256-GCM + PBKDF2 encrypted seed storage
    biometric.ts  JS bridge to the native Keystore/BiometricPrompt plugin
    screenSecurity.ts  ref-counted FLAG_SECURE toggling
    useSecureScreen.ts React hook with automatic release on unmount
    history.ts    confirmation-annotated transaction history
    servers.ts    ElectrumX endpoint pool (WebSocket) + preferred server
    money.ts      BigInt photon/RXD conversion (never float)
  screens/
    Onboarding.tsx  create / restore / passphrase
    Unlock.tsx      biometric or passphrase unlock, wipe
    Home.tsx        balance, activity list, funds by address
    Receive.tsx     QR + address
    Send.tsx        compose → review → broadcast
    Settings.tsx    servers, biometric toggle, seed backup, lock, wipe
  components/
    ActivityList.tsx  history rows with confirmation badges
  shims/          browser replacements for Node internals (see below)
android/app/src/main/java/org/radiant/wallet/
  BiometricVaultPlugin.java   AndroidKeyStore + BiometricPrompt (native)
  ScreenSecurityPlugin.java   WindowManager FLAG_SECURE (native)
  MainActivity.java           registers both plugins before the bridge starts
scripts/
  browser-path-check.ts  runtime proof: crypto path, signing, history logic
  probe-tx-parse.mjs     pins down radiantjs input/output field semantics
  check-multisign.mjs    multi-address signing-order proof
  live-e2e.mjs           live ElectrumX read + offline tx build
  probe-servers.mjs      liveness probe for every endpoint
```

### Why the shims exist

`radiantjs` was written for Node and reaches for Node internals. Bundling it for
a WebView is exactly where a wallet quietly breaks, so each replacement is
deliberate:

| Shim | Why |
| --- | --- |
| `polyfills.ts` | Installs `Buffer`, `global` and a minimal `process` on `globalThis` **before** any library module evaluates. radiantjs and its deps assume a Node-style global `Buffer`; without this the WebView threw `ReferenceError: Buffer is not defined` at startup and the app was a black screen. |
| `shims/crypto.ts` | `createHash` is deliberately **absent** so radiantjs picks its pure-JS hasher. `createHmac` **is** provided (over `js-sha512`) because `lib/mnemonic/pbkdf2.js` calls it unconditionally with no fallback — without it, *creating any wallet fails*. |
| `shims/assert.cjs` | Node's `assert` is externalized to an empty module, so `assert(…)` throws "not a function" — during HD key building and **transaction serialisation**. Must be `.cjs` so `module.exports` is the callable. |
| `shims/ws.ts` | The SDK imports `ws` only as a Node fallback; the WebView always uses the global `WebSocket`. |
| `process.browser` define | `lib/crypto/random.js` branches on it to choose Web Crypto over `crypto.randomBytes`. Without it the CSPRNG path is dead. |

### The bug that only a real browser could catch

The first APK installed as a **black screen**. Cause: a bare `Buffer` reference
in the bundle, which is fine in Node (Node defines `Buffer` globally) and fatal
in a WebView. The entire Node-based test suite passed while the app was
completely dead.

Three things came out of that:

1. `src/polyfills.ts`, imported first in `main.tsx` so the globals exist before
   any library module body runs.
2. `index.html` now has a **startup watchdog**: if the bundle throws or never
   mounts, the real error (message, stack, WebView UA) is rendered on screen
   instead of a silent black page. A wallet should fail loudly.
3. `npm run check:smoke` — serves the built bundle and loads it in headless
   Chrome, asserting the app actually mounts and no uncaught error occurred. It
   is now a CI gate, and it is verified to *fail* on the broken bundle. The APK's
   own packaged assets were smoke-tested the same way (`SMOKE_DIST=<dir>`).

None of this was guessed: `npm run check:browser` builds the app's real module
graph and asserts a known BIP39 test-vector address, a freshly generated
mnemonic, a signed transaction (sighash `0x41`, correct pubkey, sane fee), and
the history engine's direction/confirmation/fee maths against synthetic
transactions.

---

## Quick start (browser dev)

```bash
npm install
npm run dev          # http://localhost:5173
```

The app runs in a normal browser, so you can develop the whole UI without an
emulator. Web Crypto and WebSocket both work over `localhost`.

## Build the APK

**Option A — cloud build (no Android Studio needed).**
`.github/workflows/android.yml` builds a debug APK on every push to `main` (and
on manual dispatch), running `npm ci → npm run build → npm run check:browser →
npx cap sync android → ./gradlew assembleDebug`. The APK is uploaded as the
`rxd-wallet-debug-apk` artifact.

**Option B — local build.**

```bash
npm install
npm run build
npx cap sync android
cd android && ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

Verified working toolchain:

- **JDK 21.** Gradle 8.14.3 (the wrapper version) does *not* accept the JDK 25
  that ships inside Android Studio 2026.2, so `JAVA_HOME` must point at a JDK 21.
  AGP 8.13 + Gradle 8.14.3 + JDK 21 is a known-good combination.
- **Android SDK** with `platforms;android-36`; AGP pulls its own
  `build-tools;35.0.0` automatically. Point Gradle at it via
  `android/local.properties` (`sdk.dir=C:/Android/Sdk`), which is gitignored.

`minSdkVersion` is 26, `targetSdkVersion` is 36.

## Testing

```bash
npm run check:browser   # offline: crypto path, derivation, signing (fast, CI-safe)
npm run check:smoke     # loads the REAL built bundle in headless Chrome
npm run check:live      # live ElectrumX read + offline tx build (network required)
npm run probe           # which endpoints answer a handshake right now
node scripts/check-multisign.mjs   # proves input-index ↔ key pairing

cd android && ./gradlew assembleDebug   # native compile + packaging gate
```

`check:smoke` is the one that decides whether the app actually runs: it serves
`dist/` and loads it in headless Chrome, failing if `#root` never renders or an
uncaught error occurs. Everything else can pass while the app is a black screen —
that is exactly what happened once. To smoke-test the assets packaged inside an
APK, point it at extracted assets:

```bash
SMOKE_DIST=C:/Android/apk-assets npm run check:smoke
```

`check:browser` is the important one: it builds the real module graph with the
production aliases, so it catches the class of bug where the app builds fine but
fails at runtime inside the WebView.

To also exercise the app's own `connect()` failover and `scanWallet()` discovery
against mainnet, append the `--live` flag:

```bash
npx vite build -c vite.test.config.ts && node dist-test/browser-path-check.js --live
```

Last live run: connected in 1.6 s, tip height 478552, 40 addresses discovered.

---

## Security report remediation

Remediation of the static-analysis report on the debug APK. Statuses describe
what is actually verified, not what was intended.

| Finding | Status | What changed |
| --- | --- | --- |
| **HIGH-1** debuggable + WebView remote debugging | **Fixed** | `webContentsDebuggingEnabled: false` in the Capacitor config (verified present in the packaged `capacitor.config.json`), plus `WebView.setWebContentsDebuggingEnabled(false)` in `MainActivity`. Release builds are `debuggable=false` (absent from the manifest). |
| **HIGH-2** debug signing key, v2-only | **Fixed, needs your key** | Release `signingConfig` read from `android/keystore.properties` (gitignored) with v1+v2+v3+v4 signing enabled, R8 minification and resource shrinking. With no keystore present, `assembleRelease` produces an **unsigned** APK (1.57 MB) instead of a debug-signed one. |
| **MEDIUM-1** 6-char passphrase, PBKDF2 @ 310k | **Fixed** | 12-character minimum + trivial-pattern blocklist (`checkPassphrase`), PBKDF2-SHA256 raised to **600,000**, vault schema `v2`. Existing vaults still open and are **transparently re-encrypted** at the new cost on the next unlock. |
| **MEDIUM-2** single untrusted Electrum server | **Partially fixed** | Bare-IP endpoint **removed** (an IP can't match a TLS identity); `verified` now gates connect order instead of being a label; endpoints tagged by `operator`; a cross-operator tip cross-check (`crossCheckTip`, bounded to 2 peers × 5s) warns in the UI on disagreement. **This is not SPV** — still no merkle-proof or proof-of-work verification. |
| **LOW/MED-3** mnemonic resident in heap | **Improved** | Sending now requires passphrase re-authentication even in an unlocked session. JS still cannot zero memory. |
| **L1** FLAG_SECURE scoped | **Fixed** | Screenshot/recording blocking is now **app-wide by default**, with an explicit Settings opt-out for QR sharing; seed screens stay blocked either way (ref-counted). |
| **L2** WebView surface | **Fixed** | Geolocation, scripted popups, multiple windows and form-data retention disabled in `MainActivity.hardenWebView()`. |
| **L3** dev metadata in bundle | **Mitigated** | R8 strips the release bytecode; the vendored `radiantjs` `package.json` still ships inside the web bundle (informational only, no secrets). |
| **L4** trusted stored KDF params | **Fixed** | Stored iteration count is range-checked (100k–5M) and rejected outside it; KDF parameters are versioned by `v`. |

### The honest gap: MEDIUM-2 is not really solved

Verifying a server's answers requires SPV — fetch block headers, check
proof-of-work (Radiant uses SHA-512/256d), and verify each transaction's merkle
branch to the header. That is a substantial, consensus-sensitive feature and it is
**not implemented**. What exists is a cheap disagreement check — and in testing
every independent operator was offline:

```
OK   scanWallet() completed gap-limit discovery  40 addresses, 0 utxos
     (no independent server reachable — cross-check skipped)
```

So today the app still trusts one Electrum server for balances, history and
confirmation counts. The mitigation is bounded and produces no false alarms, and
it will start working the moment a second operator is reachable. Treat the server
as a semi-trusted view of the chain.

### Producing a real release build

```bash
keytool -genkeypair -v -keystore android/rxd-release.jks \
        -alias rxd -keyalg RSA -keysize 4096 -validity 10000

cat > android/keystore.properties <<'EOF'
storeFile=../rxd-release.jks
storePassword=...
keyAlias=rxd
keyPassword=...
EOF

cd android && ./gradlew assembleRelease   # → app-release.apk (signed, v1..v4)
```

Verified on the unsigned release build: manifest has **no** `debuggable`,
`allowBackup="false"`, `usesCleartextTraffic="false"`, the web bundle is present,
and — because `-keep class org.radiant.wallet.**` is in `proguard-rules.pro` — R8
**kept both plugins and all their `@PluginMethod` entry points**, so biometric
unlock and FLAG_SECURE survive minification instead of silently disappearing.

## Security model

**What is protected.** The mnemonic is encrypted with AES-256-GCM using a key
stretched from your passphrase via PBKDF2-SHA256 (600,000 iterations, 16-byte
random salt, 12-byte random IV, per-vault). Only ciphertext is stored; the
plaintext exists in memory solely while unlocked. The GCM tag means a wrong
passphrase or tampered vault fails cleanly rather than producing a garbage seed.

**Device hardening.** `android:allowBackup="false"` (so `adb backup` cannot
exfiltrate the vault), `usesCleartextTraffic="false"`, and no remote content is
ever loaded into the WebView.

**Known limitations — read these:**

1. **The native plugins compile, but have not been run on a device.** The APK
   builds cleanly and both `BiometricVaultPlugin` and `ScreenSecurityPlugin` are
   present in the APK's DEX, but a biometric prompt and `FLAG_SECURE` need real
   hardware with an enrolled fingerprint to confirm end-to-end. Everything fails
   safe — biometric errors fall back to the passphrase.
2. **Keys are held in JS memory** while unlocked (WebView), not in native
   storage. Same class of exposure as any JavaScript wallet.
3. **Screenshot blocking is framework-enforced only.** `FLAG_SECURE` is raised
   app-wide by default (opt-out in Settings for QR sharing), and always on the
   recovery-phrase surfaces. It defeats Android screenshots and MediaProjection
   recordings and blanks the Recents thumbnail, but it cannot stop a rooted
   device or someone photographing the phone with another camera.
4. **Change goes to one address** (the first unused change-chain address) rather
   than a fresh change address per transaction. It is watched by the scanner, so
   funds are never stranded, but it is weaker privacy than ideal.
5. **Address gap is fixed at 20.** If history is spread further, raise
   `GAP_LIMIT` in `src/lib/wallet.ts`; the hard cap is 200.
6. **History is capped at the 25 most recent transactions**, and each one costs
   an extra request per foreign input. A wallet with very large history will be
   slow to describe; the balance is unaffected.
7. **The vault is not independently audited.** Standard primitives, careful
   usage, but no third-party review.

## Biometric unlock — how it works

Enabling it encrypts the *entire* wallet secret blob (mnemonic + network +
server preferences, as JSON) with an AES-256-GCM key created in the
**AndroidKeyStore** with:

```java
setUserAuthenticationRequired(true)
setInvalidatedByBiometricEnrollment(true)   // a newly enrolled finger voids the key
setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG)
```

Key material never leaves the TEE. The cipher is bound to the prompt via
`BiometricPrompt.CryptoObject`, so authenticating and decrypting cannot be
separated, and only `BIOMETRIC_STRONG` (not device credential) is accepted.

The passphrase vault stays the source of truth: biometric unlock is an
additional door, never the only one. Deleting the wallet also deletes the
Keystore key, and a wrong/failed biometric leaves you on the unlock screen with
the passphrase available.

## Design system

The UI deliberately mirrors [radiantblockchain.org](https://radiantblockchain.org).
Tokens were lifted from their stylesheet (`assets/css/style.css`) rather than
eyeballed, and then verified by sampling rendered pixels:

| Token | Value | Source |
| --- | --- | --- |
| Canvas | `hsl(0,0%,0%)` `#000000` | `--color-bg` |
| Surfaces | `hsl(204,15%,6%)`, `hsl(203,18%,9%)`, `hsl(203,18%,17%)` | `--color-bg-darker/-dark/-light` |
| Brand / primary | `hsl(195,100%,44%)` **`#00A8E0`** | `--color-primary`, `--color-accent` |
| Button fill | `hsl(240,1%,10%)` | `--color-contrast-lowest` |
| Text ladder | `hsl(240,100%,99%)` → `hsl(223,8%,82%)` → `hsl(213,5%,56%)` → `hsl(208,6%,40%)` | `--color-contrast-higher/high/medium/low` |
| Typeface | **Inter Variable** (bundled via `@fontsource-variable/inter`) | Google Fonts import on the site |
| Radius | 4px base (`--radius-sm`), 6px cards, 10px sheets | `--radius-md: 0.25em` |
| Borders | hairline `hsl(208,12%,24%)`, flat surfaces, no glow | `--color-contrast-lower` |

Light mode is supported via `prefers-color-scheme` using the site's own light
token set, because their theme control defaults to *System*. Text sitting **on**
cyan stays near-black in both themes — white on `#00A8E0` is unreadable.

Verification (pixel sampling of a headless-Chrome render, quantised):

```
dark  : #000000 80.2%   #00a8e0 5.2%   #181818 4.7%    (theme=dark)
light : #ffffff 80.2%   #00a8e0 5.3%   #e0e0e0 4.8%    (theme=light)
site  : #000000 66.2%   #080810 8.2%   #101018 6.8%    (reference)
```

## App icon

Built from the official Radiant mark — `assets/brand/radiant-mark.png`, vendored
from [Radiant-Core/Radiant-Logo](https://github.com/Radiant-Core/Radiant-Logo)
(`Radiant-Logo-R-Transparent.png`: brand cyan + cream, transparent).

`npm run icons` regenerates every density:

- **Adaptive foreground** (`mipmap-*/ic_launcher_foreground.png`) — 108dp canvas,
  transparent, mark at **56%** of the canvas so it stays inside Android's 66%
  safe zone and survives circular/squircle masks.
- **Legacy icons** (`ic_launcher.png`, `ic_launcher_round.png`) — 48–192dp, mark
  at 70%/60%, black background, round variant circular-masked.
- **Adaptive background** — solid `#000000`
  (`values/ic_launcher_background.xml`), replacing the template's white.

Compositing is done in Node with `pngjs` (crop to the mark's ink → area-average
downscale → centre), not a browser. Every output's ink bounding box is then
measured and the script **fails if it is outside tolerance**, so the sizing is
verified rather than assumed:

```
OK   mipmap-xxxhdpi/ic_launcher.png              192px  ink 0.698 (target 0.7)
OK   mipmap-xxxhdpi/ic_launcher_foreground.png   432px  ink 0.56  (target 0.56)
```

Themed (monochrome) icons for Android 13+ are intentionally not provided yet;
those devices fall back to the normal full-colour icon.

## Screen privacy (anti-screen-recording)

`ScreenSecurityPlugin.java` toggles `WindowManager.LayoutParams.FLAG_SECURE` on
the app window, which makes Android refuse screenshots, exclude the window from
MediaProjection screen recordings and casting, and blank the app in the Recents
thumbnail.

It is **selective**, not app-wide — the flag is raised only while a recovery
phrase is on screen:

- creating a wallet (the 12-word backup) and entering a phrase to restore,
- the "Show recovery phrase" sheet in Settings (including its passphrase field).

So you can still screenshot a receive address or QR code, which is a normal
thing to want.

Two details that make this actually hold:

1. **Raised before paint.** The handlers `await hold()` *before* the seed is set
   in state. Doing it in a `useEffect` would run after paint and leave a
   capturable frame.
2. **Reference counted.** `FLAG_SECURE` is window-global, so a naive on/off from
   two components would let the second release clear the flag while the first
   still shows a seed. `src/lib/screenSecurity.ts` only clears it when the last
   holder releases, and each component holds at most one reference that is
   auto-released on unmount. The safe failure direction (stuck secure) is
   preferred over the dangerous one.

## Transaction confirmations

`src/lib/history.ts` builds a confirmation-annotated history using only standard
ElectrumX calls (`blockchain.scripthash.get_history`,
`blockchain.transaction.get`, `blockchain.block.header`). For each transaction it
resolves prevouts to work out the signed net effect, so a send is not mistaken
for a receive, and computes `confirmations = tip - height + 1` (0 = pending).
Block timestamps are read directly from the 80-byte header.

Non-obvious detail that is verified rather than assumed: radiantjs exposes
`input.prevTxId` **already in display byte order**, so reversing it — the usual
Bitcoin-fundamentalist reflex — would make every one of your own spends look like
a foreign input. `scripts/probe-tx-parse.mjs` pins this down.


**Never** ask anyone for your recovery phrase, and never type it into a website.
This app only ever asks for your *passphrase*, which is local to this device.

---

## Known issues / next steps

- `radiantcore.org` (Glyph/WAVE REST API) was unreachable from the development
  network, so Glyph-token and WAVE-name features are intentionally absent. The
  SDK has them; wiring them up is straightforward once that host is reachable.
- Broadcast is implemented via the standard `blockchain.transaction.broadcast`
  call but has not been exercised against mainnet with real funds.
- No price feed, no transaction history list (only UTXOs and per-address
  totals), no QR *scanner* (a `BarcodeDetector` hook fits naturally in
  `Receive.tsx`/`Send.tsx`).

**Roadmap:** QR scanning → per-transaction change addresses →
Glyph FT send/receive → fiat price.

---

## Attribution & licence

Signing, ref-safety and Glyph logic come from
[`@radiant-core/sdk`](https://github.com/Radiant-Core/radiant-sdk) and
`@radiant-core/radiantjs` (both MIT). Endpoint list adapted from
[Photonic Wallet](https://github.com/RadiantBlockchain-Community/photonic-wallet).
This wallet is an independent client and is not affiliated with the Radiant
Foundation. Use at your own risk — this is unaudited software handling real
money.


