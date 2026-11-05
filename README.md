# Radiant Wallet — non-custodial RXD for iOS

A self-custody wallet for the [Radiant](https://radiantblockchain.org) (RXD)
blockchain. Your recovery phrase is generated on the device, encrypted on the
device, and used to sign transactions on the device. No server ever sees a
private key.

Built with **React + TypeScript + Capacitor**, signing through
[`@radiant-core/sdk`](https://www.npmjs.com/package/@radiant-core/sdk) — the
same library that powers Photonic Wallet — so Radiant-specific consensus
behaviour is the ecosystem's own proven code rather than a re-implementation.

The ~90% of the code that is platform-agnostic (everything under `src/`) is
shared with the Android build in the
[radiant-wallet-android](https://github.com/birnie247/radiant-wallet-android)
repo; this repo adds the iOS native layer: the Xcode project (`ios/`) and two
app-local Swift plugins (`plugins/`).

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
| Biometric unlock (iOS Keychain + Face ID / Touch ID) | ✅ compiles (CI); not device-run |
| Recovery phrase blocks screen recording & mirroring | ✅ compiles (CI); not device-run |
| **QR scanning, Glyph tokens, WAVE names, price** | ❌ not yet |

> **Honest caveat:** no transaction has been broadcast to mainnet from this code
> by me, because that requires funds. Everything up to and including a valid
> signature is verified. Treat the first real send as a test: start small.

> **iOS platform caveat:** the two native plugins compile for the iOS
> simulator in CI, but have not been exercised on a physical iPhone yet — a
> real Face ID / Touch ID prompt and a real screen recording are the remaining
> device tests. Everything fails safe — biometric errors fall back to the
> passphrase.

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
addresses and the WIF array must stay in the same order as the inputs, or the
signature is produced by the wrong key and the transaction is rejected.
`scripts/check-multisign.mjs` pins this down with a live multi-input tx.

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
    biometric.ts  JS bridge to the native Keychain/LAContext plugin
    screenSecurity.ts  ref-counted screen-capture overlay toggling
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
plugins/
  biometric-vault/      app-local Capacitor plugin (Swift package)
    BiometricVaultPlugin.swift   Keychain AES-256-GCM key gated by Face ID / Touch ID
  screen-security/      app-local Capacitor plugin (Swift package)
    ScreenSecurityPlugin.swift   screen-recording overlay
ios/
  App/                  Xcode project (WKWebView + Capacitor via SwiftPM)
    App/Info.plist      NSFaceIDUsageDescription + scene manifest
  App/CapApp-SPM/       SwiftPM package generated by `cap sync` (DO NOT EDIT)
scripts/
  browser-path-check.ts  runtime proof: crypto path, signing, history logic
  probe-tx-parse.mjs     pins down radiantjs input/output field semantics
  check-multisign.mjs    multi-address signing-order proof
  live-e2e.mjs           live ElectrumX read + offline tx build
  probe-servers.mjs      liveness probe for every endpoint
  build-ios-icons.mjs    app icon from the official Radiant mark
  release-ios.mjs        one-command release archive
```

How the Swift plugins get registered: Capacitor 8 ships iOS plugins as Swift
packages. `npx cap sync ios` scans each plugin's Swift source for its
`@objc(ClassName)` name and records it in `capacitor.config.json`
(`packageClassList`); the Capacitor bridge then instantiates those classes by
name at startup. The plugin packages are linked into the app through the
generated `ios/App/CapApp-SPM/Package.swift`, so **edit code under `plugins/`
and re-run `npx cap sync ios`** — never edit the generated SPM package.

### Why the shims exist

`radiantjs` was written for Node and reaches for Node internals. Bundling it for
a WKWebView is exactly where a wallet quietly breaks, so each replacement is
deliberate:

| Shim | Why |
| --- | --- |
| `polyfills.ts` | Installs `Buffer`, `global` and a minimal `process` on `globalThis` **before** any library module evaluates. radiantjs and its deps assume a Node-style global `Buffer`; without this the WebView threw `ReferenceError: Buffer is not defined` at startup and the app was a black screen. |
| `shims/crypto.ts` | `createHash` is deliberately **absent** so radiantjs picks its pure-JS hasher. `createHmac` **is** provided (over `js-sha512`) because `lib/mnemonic/pbkdf2.js` calls it unconditionally with no fallback — without it, *creating any wallet fails*. |
| `shims/assert.cjs` | Node's `assert` is externalized to an empty module, so `assert(…)` throws "not a function" — during HD key building and **transaction serialisation**. Must be `.cjs` so `module.exports` is the callable. |
| `shims/ws.ts` | The SDK imports `ws` only as a Node fallback; the WKWebView always uses the global `WebSocket`. |
| `process.browser` define | `lib/crypto/random.js` branches on it to choose Web Crypto over `crypto.randomBytes`. Without it the CSPRNG path is dead. |

### The bug that only a real browser could catch

The first app build installed as a **black screen**. Cause: a bare `Buffer`
reference in the bundle, which is fine in Node (Node defines `Buffer` globally)
and fatal in a WebView. The entire Node-based test suite passed while the app
was completely dead.

Three things came out of that:

1. `src/polyfills.ts`, imported first in `main.tsx` so the globals exist before
   any library module body runs.
2. `index.html` now has a **startup watchdog**: if the bundle throws or never
   mounts, the real error (message, stack, WebView UA) is rendered on screen
   instead of a silent black page. A wallet should fail loudly.
3. `npm run check:smoke` — serves the built bundle and loads it in headless
   Chrome, asserting the app actually mounts and no uncaught error occurred. It
   is now a CI gate, and it is verified to *fail* on the broken bundle.

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
iPhone. Web Crypto and WebSocket both work over `localhost`.

## Build the app (iOS)

**Requirements:** a Mac with **Xcode** installed. If Xcode was just installed,
accept its license once:

```bash
sudo xcodebuild -license accept
```

**Option A — cloud compile gate (no Mac needed).**
`.github/workflows/ios.yml` on a `macos-latest` runner runs
`npm ci → npm run build → npm run check:browser → check:smoke →
npx cap sync ios → xcodebuild` for the iOS simulator on every push to `main`.
This is what keeps the Swift side from rotting.

**Option B — local build.**

```bash
npm install
npm run build
npx cap sync ios
npm run ios          # opens the Xcode project
```

Then pick the simulator (or your phone) as the destination and press **Run**
(⌘R). First launch takes a moment while SwiftPM resolves the Capacitor
framework.

## Installing on your own iPhone

The straightforward path is Xcode's automatic signing:

1. In Xcode, select the **App** target → *Signing & Capabilities* → your team
   (a free Apple ID works).
2. Plug in your iPhone, select it as the destination, **Run**.
3. On the phone, trust the developer certificate
   (*Settings → General → VPN & Device Management*) if prompted.

Notes:

- Free-team (personal) installs **expire after 7 days** — just press Run again.
  Apple Developer Program membership ($99/yr) removes the expiry and is what
  the App Store path needs.
- **Updates in place** require the same signing team + bundle id
  (`org.radiant.wallet.ios`); the wallet data survives. A different team
  erases the local vault — your recovery phrase is the real backup, not the app.

## Testing

```bash
npm run check:browser   # offline: crypto path, derivation, signing (fast, CI-safe)
npm run check:smoke     # loads the REAL built bundle in headless Chrome
npm run check:live      # live ElectrumX read + offline tx build (network required)
npm run probe           # which endpoints answer a handshake right now
node scripts/check-multisign.mjs   # proves input-index ↔ key pairing
npm run check:phrase    # offline BIP39 phrase checker (reads stdin, never echoes)
npm run check:restore   # E2E: drives the restore screen in a real browser (CDP)

# native compile gate (macOS):
cd ios/App && xcodebuild -project App.xcodeproj -scheme App \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

`check:phrase` covers the "the app says my recovery phrase is invalid" case: it
validates the word count, BIP39 membership and the checksum locally, hides your
typing, never repeats any of the words, and names the position of a bad word
with near-match suggestions. Nothing leaves the machine.

`check:restore` is the end-to-end proof of the restore path: it drives the real
built bundle in a headless Chromium over CDP, clicks *Restore from recovery
phrase*, fills the field and asserts the outcome for the standard BIP39 test
vectors — valid 12- and 24-word phrases must reach the passphrase step, a bad
checksum and a 13-word phrase must be rejected with the UI's own messages.

`check:smoke` needs a Chromium-based browser — Chrome, Brave, Edge and Chromium
are detected at the usual paths; set `CHROME_PATH` to point at a different one.

`check:smoke` is the one that decides whether the app actually runs: it serves
`dist/` and loads it in headless Chrome, failing if `#root` never renders or an
uncaught error occurs. Everything else can pass while the app is a black screen —
that is exactly what happened once. To smoke-test the assets packaged inside an
app build, point it at the copied web assets:

```bash
SMOKE_DIST=ios/App/App/public npm run check:smoke
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

## Security model

**What is protected.** The mnemonic is encrypted with AES-256-GCM using a key
stretched from your passphrase via PBKDF2-SHA256 (600,000 iterations, 16-byte
random salt, 12-byte random IV, per-vault). Only ciphertext is stored; the
plaintext exists in memory solely while unlocked. The GCM tag means a wrong
passphrase or tampered vault fails cleanly rather than producing a garbage seed.

**Device hardening.** The web bundle is served from a local **`https` scheme**
(`server.iosScheme` in `capacitor.config.ts`), which gives the WKWebView a
secure context — required by the clipboard API and Web Crypto — and
`allowMixedContent` is off so no remote content can ever be loaded. The app
requests no capabilities beyond network access and (only when you enable it)
Face ID, and the biometric key + ciphertext live in the Keychain, not in plain
preferences.

**Known limitations — read these:**

1. **The native plugins compile, but have not been run on a device.** The app
   builds for the iOS simulator in CI and both `BiometricVaultPlugin` and
   `ScreenSecurityPlugin` link in, but a biometric prompt and the recording
   overlay need a physical iPhone with an enrolled face/fingerprint to confirm
   end-to-end. Everything fails safe — biometric errors fall back to the
   passphrase.
2. **Keys are held in JS memory** while unlocked (WKWebView), not in native
   storage. Same class of exposure as any JavaScript wallet.
3. **iOS cannot block manual screenshots.** The screen-capture protection
   covers screen recording, AirPlay mirroring and Sidecar (an opaque overlay
   shown while capture is in progress). A volume-button screenshot *can*
   capture a recovery phrase — the UI says so explicitly, and the phrase
   surfaces keep the overlay up either way. This is a platform limit, not a
   bug; Android's `FLAG_SECURE` did block screenshots, iOS has no equivalent.
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
8. **App Store encryption declaration.** The app uses non-exempt encryption
   (AES-256-GCM, PBKDF2, secp256k1 signatures — standard for a wallet). At
   submission, App Store Connect will ask for the export-compliance
   questionnaire; the honest answers are "yes, encryption is used" with the
   standard self-classification (no restricted algorithms). Do not declare
   "no encryption" — it is factually wrong and a common rejection cause.

## Biometric unlock — how it works

Enabling it encrypts the *entire* wallet secret blob (mnemonic + network +
server preferences, as JSON) with an AES-256-GCM key created in the **iOS
Keychain** with biometry-only access control:

```swift
SecAccessControlCreateWithFlags(nil,
    kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    [.privateKeyUsage, .biometryCurrentSet],   // Face ID or Touch ID, every use
    &error)
```

`.biometryCurrentSet` means the key requires a biometric from the *currently
enrolled* set, so **enrolling a new face or fingerprint invalidates the key** —
the iOS equivalent of Android's
`setInvalidatedByBiometricEnrollment(true)`. The GCM operation itself is bound
to the key, so the OS only decrypts after a successful biometric challenge;
authenticating and decrypting cannot be separated. (The Secure Enclave cannot
be used because it does not support AES-GCM; the key material is
keychain-protected instead.)

Documented difference from the Android build: the system prompt offers no
device-passcode fallback, because the key demands biometry. The app passphrase
remains the universal fallback, exactly as before.

The passphrase vault stays the source of truth: biometric unlock is an
additional door, never the only one. Deleting the wallet also deletes the
Keychain key and ciphertext, and a failed/cancelled biometric leaves you on the
unlock screen with the passphrase available.

## Design system

The UI deliberately mirrors [radiantblockchain.org](https://radiantblockchain.org).
Tokens were lifted from their stylesheet (`assets/css/style.css`) rather than
eyeballed, and then verified by sampling rendered pixels:

| Token | Value | Source |
| --- | --- | --- |
| Canvas | `hsl(0,0%,0%)` `#000000` | `--color-bg` |
| Surfaces | `hsl(204,15%,6%)`, `hsl(203,18%,9%)`, `hsl(203,18%,17%)` | `--color-bg-darker/-dark/-light` |
| Brand / primary | `hsl(195,100%,44%)` `#00a8e0` | `--color-accent` |
| Text | `hsl(0,0%,100%)` / `hsl(210,10%,60%)` | `--color-text` / `--color-text-dim` |
| Fonts | Inter Variable (bundled, self-hosted) | `--font-*` |

No design library, no CSS framework: one `styles.css` with custom properties,
so the look cannot drift from the brand without a deliberate edit.

## App icon

`assets/brand/radiant-mark.png` is the official Radiant logo mark (vendored
from [Radiant-Core/Radiant-Logo](https://github.com/Radiant-Core/Radiant-Logo),
Apache-2.0). Do not replace it with a custom "R" or redraw the mark — use
your own unless you have permission.

`npm run icons` composites the mark onto a black 1024×1024 canvas (iOS app
icons must be fully opaque for the App Store) and writes:

- `assets/icon.png` — the source of truth for `cap sync`;
- `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png` — the
  actual App Store / home-screen icon (iOS 10+ uses a single 1024px image,
  which iOS masks into the rounded-square shape).

Compositing is done in Node with `pngjs` (crop to the mark's ink → area-average
downscale → centre), and the mark sits at **62%** of the canvas so it stays
comfortably inside Apple's corner-rounding mask. The output's ink bounding box
is measured and the script **fails if it is outside tolerance**, so the sizing
is verified rather than assumed:

```
OK   1024x1024 ink 0.62 (target 0.62)
```

## Screen privacy (anti-screen-capture)

iOS has no `FLAG_SECURE`, so `ScreenSecurityPlugin.swift` does the closest
enforceable thing: it watches `UIScreen.capturedDidChangeNotification` and,
while capture is in progress **and** protection is held, covers the window
with an opaque black layer. That defeats screen recording, AirPlay mirroring
and Sidecar — the captured frames contain nothing but black.

What it cannot do: stop a manual volume-button screenshot, or blank the
app-switcher thumbnail. Both are platform limits; the UI states them honestly
at the recovery-phrase surface ("never photograph the phrase").

The overlay is **selective plus opt-out**, not app-wide-by-default:

- it is always raised while a recovery phrase is on screen (creating a wallet,
  restoring, the "Show recovery phrase" sheet),
- and by default app-wide as well, with an explicit Settings opt-out when you
  want to share a receive QR — seed screens stay covered either way.

Two details that make this actually hold:

1. **Raised before paint.** The handlers `await hold()` *before* the seed is set
   in state. Doing it in a `useEffect` would run after paint and leave a
   capturable frame.
2. **Reference counted.** Protection is window-global, so a naive on/off from
   two components would let the second release drop the overlay while the first
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

## Known issues / next steps

- The iOS native layer needs its first **physical-device run**: Face ID /
  Touch ID prompt during enroll/unlock, the recording overlay during a real
  screen recording, and the `UIScreen.captured` behaviour in the Simulator
  (simulator recording should trigger it; verify).
- `radiantcore.org` (Glyph/WAVE REST API) was unreachable from the development
  network, so Glyph-token and WAVE-name features are intentionally absent. The
  SDK has them; wiring them up is straightforward once that host is reachable.
- Broadcast is implemented via the standard `blockchain.transaction.broadcast`
  call but has not been exercised against mainnet with real funds.
- No price feed, no transaction history list (only UTXOs and per-address
  totals), no QR *scanner* (a camera-based scanner needs the `AVFoundation`
  capability; a paste/manual-entry hook fits naturally in `Send.tsx`).

**Roadmap:** device verification of the native plugins → QR scanning →
per-transaction change addresses → Glyph FT send/receive → fiat price.

---

## Publishing to the App Store

Everything the repo can do for you is done; the rest is account and policy work
that only you can complete.

### What is already prepared

| Item | Where | Status |
| --- | --- | --- |
| Xcode project + Swift plugins | `ios/`, `plugins/` | compiles in CI |
| App icon (1024×1024) | `assets/icon.png` → `AppIcon.appiconset` | generated (`npm run icons`) |
| Privacy policy | `docs/privacy-policy.html` | written — needs hosting |
| Bundle id | `org.radiant.wallet.ios` (in `capacitor.config.ts`) | **verify it is unclaimed** in the developer portal |
| Release archive script | `npm run release` | builds an unsigned archive to `dist-ios/` |

### 1. Apple Developer account (do this yourself)

- [Apple Developer Program](https://developer.apple.com/programs/) — $99/yr
  (a personal account is fine to start; an Organization needs a D-U-N-S number).
- Register the app id **`org.radiant.wallet.ios`** in
  *Certificates, Identifiers & Profiles → Identifiers → App IDs* (if the
  identifier is already taken by someone else, change `appId` in
  `capacitor.config.ts` and re-run `npx cap add ios` — do this before the first
  submission, not after).

### 2. Build and upload

```bash
npm run release
```

This builds the web assets, syncs, archives a Release build (unsigned, so it
works without your certificates) and exports it to `dist-ios/`. Then in Xcode:
*Product → Archive*, select your team (automatic signing works for ad-hoc
testing; App Store export needs a paid team), *Distribute App → App Store
Connect → Upload*.

For ad-hoc testing with a paid team, Xcode's "Manage Devices" install is the
fastest path; for the store, the Archive/Upload path above.

### 3. Host the privacy policy

`docs/privacy-policy.html` is a single self-contained file — host it anywhere
static (GitHub Pages for this repo works) and put that URL in App Store
Connect. The policy states the app collects **nothing**.

### 4. App Store Connect setup

- **App information:** name, bundle id, version, primary language.
- **App Privacy:** the app collects **no data** — answer "We do not collect any
  data" (the Face ID usage is processed by the OS, not by us).
- **Encryption:** answer the export-compliance questionnaire honestly — the app
  **uses encryption** (AES-GCM, PBKDF2, ECDSA); standard self-classification,
  no restricted algorithms. See the security-model note above.
- **Screenshots:** capture from the Simulator (*File → Capture Screen*).
- **Age rating:** answer the questionnaire; a wallet with no gambling/violence
  content can be low-rated, but Apple treats real-money features conservatively.

### 5. Submit and roll out

Submit for review (first reviews often take a few days), then choose
**Staged** or **Manual** release.

### Honest caveats before you ship

- A first App Store review of a crypto wallet can draw an additional
  "app functionality" question — a short video of create → restore →
  receive address helps.
- Do **not** promise "screenshots are blocked" in the store listing — on iOS
  they are not (see screen privacy above). Say "screen recording is blocked
  while the recovery phrase is shown".
- Your real backup is the recovery phrase, not the app. App Store updates keep
  the local vault only while signed by the same team.

## Keeping the app updated

### Shipping a change

```bash
# 1. edit code
# 2. bump package.json version (npm version patch, or by hand)
# 3. rebuild + reinstall over the top from Xcode (same team)
npm run build && npx cap sync ios
# → Xcode: Run
```

Or `npm run release` for an archive. The marketing version and build number
come from `package.json` automatically in the release script
(`major*10000 + minor*100 + patch`).

### Three rules that matter

1. **Keep signing with the same team** — a different team is a different app
   to iOS and the wallet data does not transfer.
2. **Bump the version for every store submission** — App Store Connect rejects
   a build whose version matches one already submitted or live.
3. **The recovery phrase is the backup.** Any wipe scenario (device restore,
   team change, uninstall) is recovered from it — nothing else.

### What updates itself, and what doesn't

| Changes | How they reach the user |
| --- | --- |
| Web app (`src/`) | Rebuilt into the app; delivered with each new app build |
| Native plugins (`plugins/`) | Recompiled with each app build |
| Server list (`src/lib/servers.ts`) | Shipped in the bundle; needs an app update |
| Chain state / balances | Live, from ElectrumX, no update needed |

---

## Licence

Code: [MIT](LICENSE).

The Radiant logo mark is [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
(vendored from Radiant-Core/Radiant-Logo, see attribution below) — it may be
used and redistributed under those terms, with attribution.

## Attribution

- [Radiant](https://radiantblockchain.org) — the blockchain this wallet talks
  to. Radiant Wallet is an independent client and is not affiliated with or
  endorsed by the Radiant Foundation.
- [Radiant-Core/Radiant-Logo](https://github.com/Radiant-Core/Radiant-Logo)
  (Apache-2.0) — `assets/brand/radiant-mark.png`.
- [`@radiant-core/sdk`](https://www.npmjs.com/package/@radiant-core/sdk) and
  [`@radiant-core/radiantjs`](https://www.npmjs.com/package/@radiant-core/radiantjs)
  — consensus, HD and signing code (the same stack Photonic Wallet ships).
